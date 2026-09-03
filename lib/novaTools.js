// lib/novaTools.js
// Shared "tool registry" for Nova agentic actions.
// One definition per capability; reused by both Neurolock (routes/ai.js)
// and the external MCP server (routes/mcp.js). No backticks anywhere (Windows-safe).
//
// Each tool's run(actor, args) performs an authenticated internal HTTP call to
// Nova's own /api routes, so existing permission checks and audit logging apply
// unchanged. actor = req.user => { id, email, name, role }.
//
// Tool metadata flags:
//   write       — the tool changes data (vs. a pure read).
//   destructive — the tool deletes, approves/rejects, or sends email/SMS. These
//                 must be PROPOSED and CONFIRMED by the user before being called.
//                 Enforcement is description-driven (the model must follow the
//                 "CONFIRM FIRST" instruction); neither routes/ai.js nor
//                 routes/mcp.js currently hard-blocks on this flag, so the flag is
//                 advisory/auditing metadata plus a hook for future enforcement.

var jwt = require('jsonwebtoken');

function baseUrl() {
  return 'http://127.0.0.1:' + (process.env.PORT || 3000);
}

// Mint a short-lived JWT that impersonates the acting user for the self-call.
function mintToken(actor) {
  return jwt.sign(
    // nt marks this as an internal Nova-tools call. middleware/auth.js uses it to run
    // the onboarding gate, which is otherwise keyed on a claim this token cannot carry.
    // The ROLE in here is not trusted: requireAuth re-reads it from the database.
    { id: actor.id, email: actor.email, name: actor.name, role: actor.role, nt: true },
    process.env.JWT_SECRET,
    { expiresIn: '5m' }
  );
}

async function apiCall(actor, method, path, body) {
  var res = await fetch(baseUrl() + path, {
    method: method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + mintToken(actor)
    },
    body: body ? JSON.stringify(body) : undefined
  });
  var text = await res.text();
  var data;
  try { data = text ? JSON.parse(text) : {}; }
  catch (e) { data = { raw: text }; }
  if (!res.ok) {
    var msg = (data && data.error) ? data.error : ('HTTP ' + res.status);
    throw new Error(msg);
  }
  return data;
}

// Build a query string from a flat object, skipping empty values.
function qs(pairs) {
  var parts = [];
  for (var k in pairs) {
    if (!Object.prototype.hasOwnProperty.call(pairs, k)) continue;
    var v = pairs[k];
    if (v === undefined || v === null || v === '') continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  }
  return parts.length ? ('?' + parts.join('&')) : '';
}

// Keep response payloads small: copy only the named keys that are present.
function pick(obj, keys) {
  var out = {};
  if (!obj) return out;
  for (var i = 0; i < keys.length; i++) {
    if (obj[keys[i]] !== undefined) out[keys[i]] = obj[keys[i]];
  }
  return out;
}
function pickAll(rows, keys) {
  return (Array.isArray(rows) ? rows : []).map(function (r) { return pick(r, keys); });
}

// The asset tracker scopes a manager to their OWN cities, and someone with no
// cities and no home city gets an empty list rather than an error. Turn that
// silence into an explanation so the assistant does not report "we have none"
// when the real answer is "you cannot see any of it".
async function assetScopeNote(actor) {
  try {
    var cfg = await apiCall(actor, 'GET', '/api/assets/config');
    if (cfg && cfg.all_cities === false && Array.isArray(cfg.cities) && !cfg.cities.length) {
      return 'This came back empty because you have no cities assigned in Nova. Equipment is scoped by city, so ask an admin to set your cities or your home city.';
    }
  } catch (e) { /* the note is a nicety, never fail the tool over it */ }
  return null;
}

// Shared line-item schema fragments (concise, used by several create/update tools).
var PO_LINE_ITEMS_SCHEMA = {
  type: 'array',
  description: 'Line items. Each: { item_number?, manufacturer?, description, quantity, unit_price }.',
  items: {
    type: 'object',
    properties: {
      item_number: { type: 'string' },
      manufacturer: { type: 'string' },
      description: { type: 'string' },
      quantity: { type: 'number' },
      unit_price: { type: 'number', description: 'Our cost per unit' }
    },
    required: ['description', 'quantity', 'unit_price']
  }
};
var QUOTE_LINE_ITEMS_SCHEMA = {
  type: 'array',
  description: 'Line items. Each: { item_number?, manufacturer?, description, quantity, unit_price (our cost), list_price (customer price), taxable?, url? }.',
  items: {
    type: 'object',
    properties: {
      item_number: { type: 'string' },
      manufacturer: { type: 'string' },
      description: { type: 'string' },
      quantity: { type: 'number' },
      unit_price: { type: 'number', description: 'Our cost per unit' },
      list_price: { type: 'number', description: 'Customer-facing price per unit' },
      taxable: { type: 'boolean' },
      url: { type: 'string' }
    },
    required: ['description', 'quantity']
  }
};
var VR_LINE_ITEMS_SCHEMA = {
  type: 'array',
  description: 'Line items. Each: { description, quantity, unit_price }.',
  items: {
    type: 'object',
    properties: {
      description: { type: 'string' },
      quantity: { type: 'number' },
      unit_price: { type: 'number' }
    },
    required: ['description']
  }
};

var TOOLS = [
  // ===================================================================
  // INSIGHTS (reads)
  // ===================================================================
  {
    name: 'geico_top_employees',
    description: 'Rank employees by their Geico survey results over an optional date range. ' +
      'Returns each person with their survey count, number of Excellent ratings, number rated, ' +
      'and on-time counts. Use when asked who the top / best Geico survey performers are. ' +
      'Requires the manage_geico permission; if the user lacks it the call returns an error to relay.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date YYYY-MM-DD, inclusive (optional)' },
        to: { type: 'string', description: 'End date YYYY-MM-DD, exclusive (optional)' },
        city_code: { type: 'string', description: 'Restrict to one city code (optional)' },
        limit: { type: 'integer', description: 'How many top employees to return (default 10)' }
      }
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      args = args || {};
      var path = '/api/geico/stats' + qs({ from: args.from, to: args.to, city_code: args.city_code });
      var data = await apiCall(actor, 'GET', path);
      var emps = (data && Array.isArray(data.byEmployee)) ? data.byEmployee.slice() : [];
      emps.sort(function (a, b) { return (b.excellent - a.excellent) || (b.n - a.n); });
      var limit = (args.limit && args.limit > 0) ? args.limit : 10;
      var top = emps.slice(0, limit).map(function (e) {
        return {
          name: e.k, surveys: e.n, excellent: e.excellent,
          rated: e.rated, on_time: e.on_time, answered: e.answered
        };
      });
      return { total_surveys: data.total, top: top };
    }
  },
  {
    name: 'get_dashboard_stats',
    description: 'Get the Nova home dashboard: counts of pending vehicle repairs, open POs (this month) and their total, ' +
      'active quotes this month, fleet size, the current user pending tasks, and recent activity. Read-only.',
    input_schema: { type: 'object', properties: {} },
    write: false,
    destructive: false,
    run: async function (actor) {
      var d = await apiCall(actor, 'GET', '/api/dashboard');
      return {
        stats: d.stats,
        pending_pos: pickAll(d.pendingPOs, ['id', 'po_number', 'vendor_name', 'city_code', 'total_amount', 'status', 'requester_name']),
        pending_vrs: pickAll(d.pendingVRs, ['id', 'vr_number', 'vehicle', 'city_code', 'total_amount', 'status', 'requester_name']),
        my_tasks: pickAll(d.myTasks, ['id', 'title', 'status', 'priority', 'due_date']),
        recent_activity: pickAll(d.activity, ['entity_type', 'entity_number', 'action', 'user_name', 'created_at'])
      };
    }
  },

  // ===================================================================
  // PURCHASING — Purchase Orders
  // ===================================================================
  {
    name: 'list_purchase_orders',
    description: 'List purchase orders visible to the user (admins/managers see all; others see their own). ' +
      'Read-only. Returns id, number, vendor, customer, city, total, and status.',
    input_schema: { type: 'object', properties: {} },
    write: false,
    destructive: false,
    run: async function (actor) {
      var rows = await apiCall(actor, 'GET', '/api/pos');
      return pickAll(rows, ['id', 'po_number', 'vendor_name', 'customer_name', 'city_code', 'total_amount', 'status', 'requester_name', 'created_at']);
    }
  },
  {
    name: 'get_purchase_order',
    description: 'Get one purchase order by id, including its line items. Read-only.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      var po = await apiCall(actor, 'GET', '/api/pos/' + encodeURIComponent(args.id));
      var out = pick(po, ['id', 'po_number', 'vendor_name', 'customer_name', 'city_code', 'notes', 'total_amount', 'status', 'requester_name', 'approver_name', 'orderer_name', 'created_at']);
      out.line_items = pickAll(po.line_items, ['item_number', 'manufacturer', 'description', 'quantity', 'unit_price']);
      return out;
    }
  },
  {
    name: 'create_purchase_order',
    description: 'Create a new draft purchase order. Needs create_po permission. ' +
      'The PO number is generated automatically. Runs freely (a normal create), but make sure the ' +
      'vendor, city, and line items are right before creating.',
    input_schema: {
      type: 'object',
      properties: {
        vendor_name: { type: 'string' },
        customer_name: { type: 'string', description: 'Customer or employee the order is for (optional)' },
        city_code: { type: 'string', description: 'City code, e.g. JAX' },
        notes: { type: 'string' },
        shipping_address_id: { type: 'integer' },
        line_items: PO_LINE_ITEMS_SCHEMA
      },
      required: ['vendor_name', 'city_code', 'line_items']
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      var po = await apiCall(actor, 'POST', '/api/pos', {
        vendor_name: args.vendor_name,
        customer_name: args.customer_name,
        city_code: args.city_code,
        notes: args.notes,
        shipping_address_id: args.shipping_address_id,
        line_items: args.line_items
      });
      return pick(po, ['id', 'po_number', 'status', 'total_amount']);
    }
  },
  {
    name: 'update_purchase_order',
    description: 'Update a draft or rejected purchase order (vendor, customer, city, notes, and/or line items). ' +
      'Needs edit_po permission. Replacing line_items replaces ALL items on the PO.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        vendor_name: { type: 'string' },
        customer_name: { type: 'string' },
        city_code: { type: 'string' },
        notes: { type: 'string' },
        shipping_address_id: { type: 'integer' },
        line_items: PO_LINE_ITEMS_SCHEMA
      },
      required: ['id']
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      var body = pick(args, ['vendor_name', 'customer_name', 'city_code', 'notes', 'shipping_address_id', 'line_items']);
      var po = await apiCall(actor, 'PUT', '/api/pos/' + encodeURIComponent(args.id), body);
      return pick(po, ['id', 'po_number', 'status', 'total_amount']);
    }
  },
  {
    name: 'submit_purchase_order',
    description: 'CONFIRM FIRST — do not call until the user has explicitly approved. Submits a draft/rejected PO for approval, ' +
      'which emails and texts the admins. Propose the action and wait for a clear yes before calling.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      await apiCall(actor, 'POST', '/api/pos/' + encodeURIComponent(args.id) + '/submit');
      return { id: args.id, submitted: true };
    }
  },
  {
    name: 'approve_purchase_order',
    description: 'CONFIRM FIRST — do not call until the user has explicitly approved. Approves a submitted PO and notifies the requester. ' +
      'Needs approve_po permission. Requires orderer_id (the user who will place the order).',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer' }, orderer_id: { type: 'integer', description: 'User id assigned to place the order' } },
      required: ['id', 'orderer_id']
    },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      await apiCall(actor, 'POST', '/api/pos/' + encodeURIComponent(args.id) + '/approve', { orderer_id: args.orderer_id });
      return { id: args.id, approved: true };
    }
  },
  {
    name: 'reject_purchase_order',
    description: 'CONFIRM FIRST — do not call until the user has explicitly approved. Rejects a submitted PO and notifies the requester. ' +
      'Needs approve_po permission. Include a reason when you have one.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer' }, reason: { type: 'string' } },
      required: ['id']
    },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      await apiCall(actor, 'POST', '/api/pos/' + encodeURIComponent(args.id) + '/reject', { reason: args.reason });
      return { id: args.id, rejected: true };
    }
  },
  {
    name: 'cancel_purchase_order',
    description: 'CONFIRM FIRST — do not call until the user has explicitly approved. Cancels a non-draft PO and notifies the requester. ' +
      'Needs cancel_po permission. (Use delete_purchase_order for drafts.)',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      await apiCall(actor, 'POST', '/api/pos/' + encodeURIComponent(args.id) + '/cancel');
      return { id: args.id, cancelled: true };
    }
  },
  {
    name: 'mark_purchase_order_ordered',
    description: 'CONFIRM FIRST — do not call until the user has explicitly approved. Marks an approved PO as "order placed" and notifies the requester. ' +
      'Only the assigned orderer or an admin can do this.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      await apiCall(actor, 'POST', '/api/pos/' + encodeURIComponent(args.id) + '/order');
      return { id: args.id, ordered: true };
    }
  },
  {
    name: 'delete_purchase_order',
    description: 'CONFIRM FIRST — do not call until the user has explicitly approved. Permanently deletes a PO. ' +
      'Admins can delete any; others only their own drafts. This cannot be undone.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      await apiCall(actor, 'DELETE', '/api/pos/' + encodeURIComponent(args.id));
      return { id: args.id, deleted: true };
    }
  },

  // ===================================================================
  // PURCHASING — Quotes
  // ===================================================================
  {
    name: 'list_quotes',
    description: 'List quotes visible to the user (admins/managers see all; others see their own). Read-only.',
    input_schema: { type: 'object', properties: {} },
    write: false,
    destructive: false,
    run: async function (actor) {
      var rows = await apiCall(actor, 'GET', '/api/quotes');
      return pickAll(rows, ['id', 'quote_number', 'customer_name', 'city_code', 'total_amount', 'requester_name', 'created_at']);
    }
  },
  {
    name: 'get_quote',
    description: 'Get one quote by id, including line items. Read-only.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      var q = await apiCall(actor, 'GET', '/api/quotes/' + encodeURIComponent(args.id));
      var out = pick(q, ['id', 'quote_number', 'customer_name', 'city_code', 'notes', 'important_info', 'tax_rate', 'tax_amount', 'total_amount', 'requester_name', 'created_at']);
      out.line_items = pickAll(q.line_items, ['item_number', 'manufacturer', 'description', 'quantity', 'unit_price', 'list_price', 'taxable', 'url']);
      return out;
    }
  },
  {
    name: 'create_quote',
    description: 'Create a customer quote with line items. Needs create_quote permission. The quote number is generated automatically.',
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string' },
        city_code: { type: 'string' },
        notes: { type: 'string' },
        important_info: { type: 'string' },
        tax_rate: { type: 'number', description: 'Tax rate percent, e.g. 7.5' },
        line_items: QUOTE_LINE_ITEMS_SCHEMA
      },
      required: ['customer_name', 'line_items']
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      var q = await apiCall(actor, 'POST', '/api/quotes', pick(args, ['customer_name', 'city_code', 'notes', 'important_info', 'tax_rate', 'line_items']));
      return pick(q, ['id', 'quote_number', 'total_amount']);
    }
  },
  {
    name: 'update_quote',
    description: 'Update a quote (customer, city, notes, tax rate, line items). Needs edit_quote permission. Replacing line_items replaces ALL items.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        customer_name: { type: 'string' },
        city_code: { type: 'string' },
        notes: { type: 'string' },
        important_info: { type: 'string' },
        tax_rate: { type: 'number' },
        line_items: QUOTE_LINE_ITEMS_SCHEMA
      },
      required: ['id', 'customer_name', 'line_items']
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      var r = await apiCall(actor, 'PUT', '/api/quotes/' + encodeURIComponent(args.id), pick(args, ['customer_name', 'city_code', 'notes', 'important_info', 'tax_rate', 'line_items']));
      return { id: (r && r.id) || args.id, updated: true };
    }
  },
  {
    name: 'push_quote_to_po',
    description: 'CONFIRM FIRST — do not call until the user has explicitly approved. Turns a quote into purchase order(s) — one per supplier — ' +
      'and SUBMITS them for approval (emails/texts the admins). The quote must have a city set. Needs push_quote_po permission.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      var r = await apiCall(actor, 'POST', '/api/quotes/' + encodeURIComponent(args.id) + '/push-to-po');
      return { count: r.count, pos: pickAll(r.pos, ['id', 'po_number', 'vendor_name', 'total']) };
    }
  },
  {
    name: 'delete_quote',
    description: 'CONFIRM FIRST — do not call until the user has explicitly approved. Permanently deletes a quote. Cannot be undone.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      await apiCall(actor, 'DELETE', '/api/quotes/' + encodeURIComponent(args.id));
      return { id: args.id, deleted: true };
    }
  },

  // ===================================================================
  // PURCHASING — Vendors / Accounts
  // ===================================================================
  {
    name: 'list_vendors',
    description: 'List vendors/accounts. Needs manage_vendors permission. Read-only. Passwords are returned by the API; do not surface them unless asked.',
    input_schema: { type: 'object', properties: {} },
    write: false,
    destructive: false,
    run: async function (actor) {
      var rows = await apiCall(actor, 'GET', '/api/vendors');
      return pickAll(rows, ['id', 'name', 'website', 'account_number', 'city_code', 'rep_name', 'rep_email', 'rep_phone', 'show_in_invoice']);
    }
  },
  {
    name: 'create_vendor',
    description: 'Create a vendor/account. Needs manage_vendors permission.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        website: { type: 'string' },
        account_number: { type: 'string' },
        username: { type: 'string' },
        password: { type: 'string' },
        notes: { type: 'string' },
        rep_name: { type: 'string' },
        rep_email: { type: 'string' },
        rep_phone: { type: 'string' },
        city_code: { type: 'string' },
        show_in_invoice: { type: 'boolean' },
        invoice_notes: { type: 'string' }
      },
      required: ['name']
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      var v = await apiCall(actor, 'POST', '/api/vendors', pick(args, ['name', 'website', 'account_number', 'username', 'password', 'notes', 'rep_name', 'rep_email', 'rep_phone', 'city_code', 'show_in_invoice', 'invoice_notes']));
      return pick(v, ['id', 'name', 'account_number', 'city_code']);
    }
  },
  {
    name: 'update_vendor',
    description: 'Update a vendor/account. Needs manage_vendors permission. Name is required by the API; pass the existing name if unchanged.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
        website: { type: 'string' },
        account_number: { type: 'string' },
        username: { type: 'string' },
        password: { type: 'string' },
        notes: { type: 'string' },
        rep_name: { type: 'string' },
        rep_email: { type: 'string' },
        rep_phone: { type: 'string' },
        city_code: { type: 'string' },
        show_in_invoice: { type: 'boolean' },
        invoice_notes: { type: 'string' }
      },
      required: ['id', 'name']
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      var v = await apiCall(actor, 'PUT', '/api/vendors/' + encodeURIComponent(args.id), pick(args, ['name', 'website', 'account_number', 'username', 'password', 'notes', 'rep_name', 'rep_email', 'rep_phone', 'city_code', 'show_in_invoice', 'invoice_notes']));
      return pick(v, ['id', 'name', 'account_number', 'city_code']);
    }
  },
  {
    name: 'delete_vendor',
    description: 'CONFIRM FIRST — do not call until the user has explicitly approved. Permanently deletes a vendor/account. Needs manage_vendors permission.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      await apiCall(actor, 'DELETE', '/api/vendors/' + encodeURIComponent(args.id));
      return { id: args.id, deleted: true };
    }
  },

  // ===================================================================
  // PURCHASING — Parts catalog
  // ===================================================================
  {
    name: 'search_parts',
    description: 'Search the parts catalog by item number, alias, description, or vendor. Any authenticated user can search. ' +
      'Omit q to list parts. Read-only.',
    input_schema: { type: 'object', properties: { q: { type: 'string', description: 'Search text (optional)' } } },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      args = args || {};
      var rows = await apiCall(actor, 'GET', '/api/parts' + qs({ q: args.q }));
      return pickAll(rows, ['id', 'item_number', 'alias', 'description', 'price', 'preferred_vendor']);
    }
  },
  {
    name: 'create_part',
    description: 'Add a part to the catalog. Needs manage_parts permission. Description is required.',
    input_schema: {
      type: 'object',
      properties: {
        item_number: { type: 'string' },
        alias: { type: 'string' },
        description: { type: 'string' },
        price: { type: 'number' },
        preferred_vendor: { type: 'string' }
      },
      required: ['description']
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      var p = await apiCall(actor, 'POST', '/api/parts', pick(args, ['item_number', 'alias', 'description', 'price', 'preferred_vendor']));
      return pick(p, ['id', 'item_number', 'description', 'price']);
    }
  },
  {
    name: 'update_part',
    description: 'Update a catalog part. Needs manage_parts permission. Description is required.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        item_number: { type: 'string' },
        alias: { type: 'string' },
        description: { type: 'string' },
        price: { type: 'number' },
        preferred_vendor: { type: 'string' }
      },
      required: ['id', 'description']
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      var p = await apiCall(actor, 'PUT', '/api/parts/' + encodeURIComponent(args.id), pick(args, ['item_number', 'alias', 'description', 'price', 'preferred_vendor']));
      return pick(p, ['id', 'item_number', 'description', 'price']);
    }
  },
  {
    name: 'delete_part',
    description: 'CONFIRM FIRST — do not call until the user has explicitly approved. Permanently deletes a catalog part. Needs manage_parts permission.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      await apiCall(actor, 'DELETE', '/api/parts/' + encodeURIComponent(args.id));
      return { id: args.id, deleted: true };
    }
  },

  // ===================================================================
  // PURCHASING — Running (Monthly) list
  // ===================================================================
  {
    name: 'list_running_list',
    description: 'List active running-list (monthly requisition) items. scope "mine" returns the user own list; ' +
      'scope "all" returns every city item and needs manage_running permission. Read-only.',
    input_schema: { type: 'object', properties: { scope: { type: 'string', enum: ['mine', 'all'], description: 'Default mine' } } },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      args = args || {};
      var path = (args.scope === 'all') ? '/api/running/admin' : '/api/running';
      var rows = await apiCall(actor, 'GET', path);
      return pickAll(rows, ['id', 'city_code', 'description', 'quantity', 'unit_price', 'vendor_name', 'part_number', 'requester_name', 'created_at']);
    }
  },
  {
    name: 'add_running_item',
    description: 'Add an item to the running (monthly) list for a city. Any authenticated user can add to their assigned cities.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        city_code: { type: 'string' },
        quantity: { type: 'number' },
        unit_price: { type: 'number' },
        vendor_name: { type: 'string' },
        part_number: { type: 'string' },
        link: { type: 'string' },
        notes: { type: 'string' }
      },
      required: ['description', 'city_code']
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      var r = await apiCall(actor, 'POST', '/api/running', pick(args, ['description', 'city_code', 'quantity', 'unit_price', 'vendor_name', 'part_number', 'link', 'notes']));
      return pick(r, ['id', 'city_code', 'description', 'quantity']);
    }
  },
  {
    name: 'create_po_from_running_list',
    description: 'Roll a city running list into a single draft PO. Needs manage_running permission. ' +
      'Pass item_ids to include only specific items, otherwise all active items for the city are used. Creates a draft (does not auto-submit).',
    input_schema: {
      type: 'object',
      properties: {
        city_code: { type: 'string' },
        vendor_name: { type: 'string', description: 'Optional override; otherwise derived from the items' },
        item_ids: { type: 'array', items: { type: 'integer' } }
      },
      required: ['city_code']
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      var po = await apiCall(actor, 'POST', '/api/running/create-po', pick(args, ['city_code', 'vendor_name', 'item_ids']));
      return pick(po, ['id', 'po_number', 'status', 'total_amount']);
    }
  },

  // ===================================================================
  // FLEET & REPAIRS — Vehicle Repairs
  // ===================================================================
  {
    name: 'list_vehicle_repairs',
    description: 'List vehicle repairs visible to the user (admins/managers see all; others see their own). ' +
      'Optionally filter by vehicle_id. Read-only.',
    input_schema: { type: 'object', properties: { vehicle_id: { type: 'integer' } } },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      args = args || {};
      var rows = await apiCall(actor, 'GET', '/api/vr' + qs({ vehicle_id: args.vehicle_id }));
      return pickAll(rows, ['id', 'vr_number', 'vehicle', 'shop_name', 'city_code', 'total_amount', 'status', 'requester_name', 'assigned_name', 'created_at']);
    }
  },
  {
    name: 'get_vehicle_repair',
    description: 'Get one vehicle repair by id, including line items. Read-only.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      var vr = await apiCall(actor, 'GET', '/api/vr/' + encodeURIComponent(args.id));
      var out = pick(vr, ['id', 'vr_number', 'vehicle', 'vin_last6', 'shop_name', 'city_code', 'notes', 'total_amount', 'status', 'requester_name', 'assigned_name', 'created_at']);
      out.line_items = pickAll(vr.line_items, ['description', 'quantity', 'unit_price']);
      return out;
    }
  },
  {
    name: 'create_vehicle_repair',
    description: 'Create a draft vehicle repair (VR). Needs create_vr permission. The VR number is generated automatically.',
    input_schema: {
      type: 'object',
      properties: {
        vehicle: { type: 'string', description: 'Year make model as a single string' },
        vin_last6: { type: 'string' },
        vehicle_id: { type: 'integer', description: 'Fleet vehicle id if this is a fleet vehicle' },
        assigned_user_id: { type: 'integer' },
        shop_name: { type: 'string' },
        city_code: { type: 'string' },
        notes: { type: 'string' },
        line_items: VR_LINE_ITEMS_SCHEMA
      },
      required: ['vehicle']
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      var vr = await apiCall(actor, 'POST', '/api/vr', pick(args, ['vehicle', 'vin_last6', 'vehicle_id', 'assigned_user_id', 'shop_name', 'city_code', 'notes', 'line_items']));
      return pick(vr, ['id', 'vr_number', 'status', 'total_amount']);
    }
  },
  {
    name: 'update_vehicle_repair',
    description: 'Update a draft vehicle repair. Needs edit_vr permission. Only draft VRs can be edited. Replacing line_items replaces ALL items.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        vehicle: { type: 'string' },
        vin_last6: { type: 'string' },
        vehicle_id: { type: 'integer' },
        assigned_user_id: { type: 'integer' },
        shop_name: { type: 'string' },
        city_code: { type: 'string' },
        notes: { type: 'string' },
        line_items: VR_LINE_ITEMS_SCHEMA
      },
      required: ['id', 'vehicle']
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      var r = await apiCall(actor, 'PUT', '/api/vr/' + encodeURIComponent(args.id), pick(args, ['vehicle', 'vin_last6', 'vehicle_id', 'assigned_user_id', 'shop_name', 'city_code', 'notes', 'line_items']));
      return { id: (r && r.id) || args.id, updated: true };
    }
  },
  {
    name: 'submit_vehicle_repair',
    description: 'CONFIRM FIRST — do not call until the user has explicitly approved. Submits a draft VR for approval, which emails/texts the admins. ' +
      'Needs submit_vr permission.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      await apiCall(actor, 'POST', '/api/vr/' + encodeURIComponent(args.id) + '/submit');
      return { id: args.id, submitted: true };
    }
  },
  {
    name: 'approve_vehicle_repair',
    description: 'CONFIRM FIRST — do not call until the user has explicitly approved. Approves a submitted VR and notifies the requester. Needs approve_vr permission.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      await apiCall(actor, 'POST', '/api/vr/' + encodeURIComponent(args.id) + '/approve');
      return { id: args.id, approved: true };
    }
  },
  {
    name: 'reject_vehicle_repair',
    description: 'CONFIRM FIRST — do not call until the user has explicitly approved. Rejects a submitted VR and notifies the requester. Needs approve_vr permission.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' }, reason: { type: 'string' } }, required: ['id'] },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      await apiCall(actor, 'POST', '/api/vr/' + encodeURIComponent(args.id) + '/reject', { reason: args.reason });
      return { id: args.id, rejected: true };
    }
  },
  {
    name: 'delete_vehicle_repair',
    description: 'CONFIRM FIRST — do not call until the user has explicitly approved. Permanently deletes a VR. Admins can delete any; others only their own drafts.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      await apiCall(actor, 'DELETE', '/api/vr/' + encodeURIComponent(args.id));
      return { id: args.id, deleted: true };
    }
  },

  // ===================================================================
  // FLEET & REPAIRS — Fleet registry (Vehicles)
  // ===================================================================
  {
    name: 'list_vehicles',
    description: 'List fleet vehicles. By default returns active vehicles; pass city_code to filter. ' +
      'Set include_inactive true to list every vehicle (needs manage_vehicles permission). Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        city_code: { type: 'string' },
        include_inactive: { type: 'boolean' }
      }
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      args = args || {};
      var path = args.include_inactive ? '/api/vehicles/all' : ('/api/vehicles' + qs({ city_code: args.city_code }));
      var rows = await apiCall(actor, 'GET', path);
      return pickAll(rows, ['id', 'year', 'make_model', 'license_plate', 'vin', 'city_code', 'driver_name', 'mileage', 'active']);
    }
  },
  {
    name: 'get_vehicle',
    description: 'Get one fleet vehicle by id (includes key codes and assignment). Read-only.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      var v = await apiCall(actor, 'GET', '/api/vehicles/' + encodeURIComponent(args.id));
      return pick(v, ['id', 'year', 'make_model', 'vin', 'key_codes', 'license_plate', 'city_code', 'driver_name', 'assigned_user_id', 'date_of_assignment', 'mileage', 'notes', 'active', 'sold_to', 'sold_for', 'sold_date']);
    }
  },
  {
    name: 'create_vehicle',
    description: 'Add a vehicle to the fleet registry. Needs manage_vehicles permission. Year and make_model are required.',
    input_schema: {
      type: 'object',
      properties: {
        year: { type: 'integer' },
        make_model: { type: 'string' },
        vin: { type: 'string' },
        key_codes: { type: 'string' },
        assigned_user_id: { type: 'integer' },
        city_code: { type: 'string' },
        date_of_assignment: { type: 'string', description: 'YYYY-MM-DD' },
        license_plate: { type: 'string' },
        mileage: { type: 'integer' },
        notes: { type: 'string' }
      },
      required: ['year', 'make_model']
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      var v = await apiCall(actor, 'POST', '/api/vehicles', pick(args, ['year', 'make_model', 'vin', 'key_codes', 'assigned_user_id', 'city_code', 'date_of_assignment', 'license_plate', 'mileage', 'notes']));
      return pick(v, ['id', 'year', 'make_model', 'city_code']);
    }
  },
  {
    name: 'update_vehicle',
    description: 'Update a fleet vehicle. Needs manage_vehicles permission. Year and make_model are required.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        year: { type: 'integer' },
        make_model: { type: 'string' },
        vin: { type: 'string' },
        key_codes: { type: 'string' },
        assigned_user_id: { type: 'integer' },
        city_code: { type: 'string' },
        date_of_assignment: { type: 'string' },
        license_plate: { type: 'string' },
        mileage: { type: 'integer' },
        notes: { type: 'string' }
      },
      required: ['id', 'year', 'make_model']
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      var v = await apiCall(actor, 'PUT', '/api/vehicles/' + encodeURIComponent(args.id), pick(args, ['year', 'make_model', 'vin', 'key_codes', 'assigned_user_id', 'city_code', 'date_of_assignment', 'license_plate', 'mileage', 'notes']));
      return pick(v, ['id', 'year', 'make_model', 'city_code']);
    }
  },
  {
    name: 'sell_vehicle',
    description: 'CONFIRM FIRST — do not call until the user has explicitly approved. Records the sale of a fleet vehicle and marks it inactive. ' +
      'Needs manage_vehicles permission. Buyer name and sale date are required.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        sold_to: { type: 'string' },
        sold_for: { type: 'number' },
        sold_date: { type: 'string', description: 'YYYY-MM-DD' }
      },
      required: ['id', 'sold_to', 'sold_date']
    },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      await apiCall(actor, 'POST', '/api/vehicles/' + encodeURIComponent(args.id) + '/sell', pick(args, ['sold_to', 'sold_for', 'sold_date']));
      return { id: args.id, sold: true };
    }
  },

  // ===================================================================
  // TASKS & WORK — Tasks
  // ===================================================================
  {
    name: 'list_my_tasks',
    description: 'List the current user open and recent tasks (their own task list). ' +
      'Use to check what the user already has on their plate before creating duplicates.',
    input_schema: { type: 'object', properties: {} },
    write: false,
    destructive: false,
    run: async function (actor) {
      var data = await apiCall(actor, 'GET', '/api/tasks?view=mine');
      var rows = Array.isArray(data) ? data : [];
      return rows.map(function (t) {
        return { id: t.id, title: t.title, status: t.status, priority: t.priority, due_date: t.due_date };
      });
    }
  },
  {
    name: 'create_task',
    description: 'Create a task or reminder for the current user. ' +
      'Only call this when the user has clearly asked to create/remember something. ' +
      'If the request is ambiguous, ask the user to confirm the title and due date first. ' +
      'Compute due_date yourself from the current date provided in the system prompt ' +
      '(for example "in 3 days").',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title' },
        description: { type: 'string', description: 'Optional extra details' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'], description: 'Default medium' },
        due_date: { type: 'string', description: 'Due date YYYY-MM-DD (optional)' }
      },
      required: ['title']
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      args = args || {};
      var body = { title: args.title };
      if (args.description) body.description = args.description;
      if (args.priority) body.priority = args.priority;
      if (args.due_date) body.due_date = args.due_date;
      body.assigned_to = actor.id;
      var data = await apiCall(actor, 'POST', '/api/tasks', body);
      return { id: data.id, title: data.title, due_date: data.due_date, status: data.status };
    }
  },
  {
    name: 'update_task',
    description: 'Update a task title, description, priority, due date, or assignee. Needs manage_tasks permission ' +
      '(to edit tasks you created or manage). To just change status, prefer set_task_status.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
        due_date: { type: 'string', description: 'YYYY-MM-DD' },
        assigned_to: { type: 'integer', description: 'User id to assign (assigning to others needs manage_tasks)' }
      },
      required: ['id']
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      var t = await apiCall(actor, 'PUT', '/api/tasks/' + encodeURIComponent(args.id), pick(args, ['title', 'description', 'priority', 'due_date', 'assigned_to']));
      return pick(t, ['id', 'title', 'status', 'priority', 'due_date', 'assignee_name']);
    }
  },
  {
    name: 'set_task_status',
    description: 'Set a task status: todo, in_progress, or done. The assignee or a manager can do this. ' +
      'Use status "done" to mark a task complete.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'done'] }
      },
      required: ['id', 'status']
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      var t = await apiCall(actor, 'PATCH', '/api/tasks/' + encodeURIComponent(args.id) + '/status', { status: args.status });
      return pick(t, ['id', 'title', 'status']);
    }
  },
  {
    name: 'delete_task',
    description: 'CONFIRM FIRST — do not call until the user has explicitly approved. Permanently deletes a task. Needs manage_tasks permission.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      await apiCall(actor, 'DELETE', '/api/tasks/' + encodeURIComponent(args.id));
      return { id: args.id, deleted: true };
    }
  },

  // ===================================================================
  // TASKS & WORK — Work Orders
  // ===================================================================
  {
    name: 'list_work_orders',
    description: 'List work orders with optional filters (status, account_id, assigned_to, city_code, search q, from/to dates). ' +
      'Needs view_work_orders permission. Returns up to "limit" items (default 25). Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['received', 'in_process', 'job_completed', 'paperwork_sent', 'rejected', 'error'] },
        account_id: { type: 'integer' },
        assigned_to: { type: 'integer' },
        city_code: { type: 'string' },
        q: { type: 'string' },
        from: { type: 'string', description: 'YYYY-MM-DD inclusive' },
        to: { type: 'string', description: 'YYYY-MM-DD exclusive' },
        limit: { type: 'integer' },
        offset: { type: 'integer' }
      }
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      args = args || {};
      var data = await apiCall(actor, 'GET', '/api/work-orders' + qs(pick(args, ['status', 'account_id', 'assigned_to', 'city_code', 'q', 'from', 'to', 'limit', 'offset'])));
      return {
        total: data.total,
        items: pickAll(data.items, ['id', 'wo_ref', 'status', 'priority', 'account_name', 'store_name', 'store_number', 'service_requested', 'needed_by', 'assignee_name', 'created_at'])
      };
    }
  },
  {
    name: 'get_work_order',
    description: 'Get one work order by id, including activity and attachment list. Needs view_work_orders permission. Read-only.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      var wo = await apiCall(actor, 'GET', '/api/work-orders/' + encodeURIComponent(args.id));
      return pick(wo, ['id', 'wo_ref', 'status', 'priority', 'account_name', 'account_number', 'city_code', 'po_number', 'wo_number', 'store_name', 'store_number', 'address', 'city_state_zip', 'service_requested', 'contact_name', 'contact_phone', 'needed_by', 'notes', 'assignee_name', 'created_at']);
    }
  },
  {
    name: 'create_work_order',
    description: 'Manually create a work order. Needs manage_work_orders permission. ' +
      'Provide at least an account, store, or the service requested.',
    input_schema: {
      type: 'object',
      properties: {
        account_name: { type: 'string' },
        account_number: { type: 'string' },
        po_number: { type: 'string' },
        wo_number: { type: 'string' },
        store_name: { type: 'string' },
        store_number: { type: 'string' },
        address: { type: 'string' },
        city_state_zip: { type: 'string' },
        service_requested: { type: 'string' },
        contact_name: { type: 'string' },
        contact_phone: { type: 'string' },
        needed_by: { type: 'string', description: 'YYYY-MM-DD' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        assigned_to: { type: 'integer' },
        notes: { type: 'string' }
      }
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      var wo = await apiCall(actor, 'POST', '/api/work-orders', pick(args, ['account_name', 'account_number', 'po_number', 'wo_number', 'store_name', 'store_number', 'address', 'city_state_zip', 'service_requested', 'contact_name', 'contact_phone', 'needed_by', 'priority', 'assigned_to', 'notes']));
      return pick(wo, ['id', 'wo_ref', 'status', 'account_name']);
    }
  },
  {
    name: 'update_work_order',
    description: 'Edit work order fields. Needs manage_work_orders permission.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        account_name: { type: 'string' },
        account_number: { type: 'string' },
        po_number: { type: 'string' },
        wo_number: { type: 'string' },
        store_name: { type: 'string' },
        store_number: { type: 'string' },
        address: { type: 'string' },
        city_state_zip: { type: 'string' },
        service_requested: { type: 'string' },
        contact_name: { type: 'string' },
        contact_phone: { type: 'string' },
        needed_by: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        assigned_to: { type: 'integer' },
        notes: { type: 'string' }
      },
      required: ['id']
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      var wo = await apiCall(actor, 'PUT', '/api/work-orders/' + encodeURIComponent(args.id), pick(args, ['account_name', 'account_number', 'po_number', 'wo_number', 'store_name', 'store_number', 'address', 'city_state_zip', 'service_requested', 'contact_name', 'contact_phone', 'needed_by', 'priority', 'assigned_to', 'notes']));
      return pick(wo, ['id', 'wo_ref', 'status', 'account_name']);
    }
  },
  {
    name: 'set_work_order_status',
    description: 'Set a work order status (received, in_process, job_completed, paperwork_sent, rejected, error). ' +
      'Needs manage_work_orders permission. Moving to in_process stamps the reviewer and creates a pending sign-off. ' +
      'Optionally reassign with assigned_to.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        status: { type: 'string', enum: ['received', 'in_process', 'job_completed', 'paperwork_sent', 'rejected', 'error'] },
        assigned_to: { type: 'integer' }
      },
      required: ['id', 'status']
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      var body = { status: args.status };
      if (args.assigned_to !== undefined) body.assigned_to = args.assigned_to;
      var wo = await apiCall(actor, 'PATCH', '/api/work-orders/' + encodeURIComponent(args.id) + '/status', body);
      return pick(wo, ['id', 'wo_ref', 'status', 'assignee_name']);
    }
  },
  {
    name: 'delete_work_order',
    description: 'CONFIRM FIRST — do not call until the user has explicitly approved. Permanently deletes a work order. Needs manage_work_orders permission.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      await apiCall(actor, 'DELETE', '/api/work-orders/' + encodeURIComponent(args.id));
      return { id: args.id, deleted: true };
    }
  },

  // ===================================================================
  // TASKS & WORK — Suggestions
  // ===================================================================
  {
    name: 'list_suggestions',
    description: 'List employee suggestions. Admins/managers only. Read-only.',
    input_schema: { type: 'object', properties: {} },
    write: false,
    destructive: false,
    run: async function (actor) {
      var rows = await apiCall(actor, 'GET', '/api/suggestions');
      return pickAll(rows, ['id', 'category', 'suggestion', 'status', 'admin_notes', 'submitter_name', 'anonymous', 'created_at']);
    }
  },
  {
    name: 'submit_suggestion',
    description: 'CONFIRM FIRST - this emails and texts every admin and manager, so do not call it until the user has explicitly approved the wording. ' +
      'Submits an employee suggestion. Any authenticated user can submit. ' +
      'Set anonymous true to hide the submitter.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        suggestion: { type: 'string' },
        anonymous: { type: 'boolean' }
      },
      required: ['category', 'suggestion']
    },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      var s = await apiCall(actor, 'POST', '/api/suggestions', pick(args, ['category', 'suggestion', 'anonymous']));
      return pick(s, ['id', 'category', 'status']);
    }
  },
  {
    name: 'update_suggestion',
    description: 'Update a suggestion status and/or admin notes. Admins/managers only.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        status: { type: 'string' },
        admin_notes: { type: 'string' }
      },
      required: ['id']
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      var s = await apiCall(actor, 'PUT', '/api/suggestions/' + encodeURIComponent(args.id), pick(args, ['status', 'admin_notes']));
      return pick(s, ['id', 'status', 'admin_notes']);
    }
  },
  {
    name: 'delete_suggestion',
    description: 'CONFIRM FIRST — do not call until the user has explicitly approved. Permanently deletes a suggestion. Admins/managers only.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      await apiCall(actor, 'DELETE', '/api/suggestions/' + encodeURIComponent(args.id));
      return { id: args.id, deleted: true };
    }
  },

  // ===================================================================
  // INSIGHTS — Invoices, Deposits, Reviews
  // ===================================================================
  {
    name: 'list_invoices',
    description: 'List field invoices (admins/managers see all; others see their own). Read-only.',
    input_schema: { type: 'object', properties: {} },
    write: false,
    destructive: false,
    run: async function (actor) {
      var rows = await apiCall(actor, 'GET', '/api/invoices');
      return pickAll(rows, ['id', 'invoice_number', 'customer_name', 'account_name', 'pay_type', 'grand_total', 'status', 'invoice_date', 'locksmith_name_join', 'created_at']);
    }
  },
  {
    name: 'get_invoice',
    description: 'Get one invoice by id, including line items. Read-only. Signature image is omitted from the result.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      var inv = await apiCall(actor, 'GET', '/api/invoices/' + encodeURIComponent(args.id));
      var out = pick(inv, ['id', 'invoice_number', 'status', 'invoice_date', 'account_name', 'customer_name', 'phone', 'email', 'vehicle_year', 'vehicle_make', 'vehicle_model', 'pay_type', 'card_last4', 'tax_rate', 'labor_amount', 'parts_amount', 'subtotal', 'tax_amount', 'tip_amount', 'grand_total', 'notes', 'locksmith_name_join', 'created_at']);
      out.line_items = pickAll(inv.line_items, ['line_type', 'item_number', 'description', 'quantity', 'unit_price', 'taxable']);
      return out;
    }
  },
  {
    name: 'create_invoice',
    description: 'Create a field invoice with line items. Needs create_invoice permission. The invoice number is generated automatically. ' +
      'Line items: each { line_type: "labor"|"part", description, quantity, unit_price, taxable?, item_number? }.',
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string' },
        account_id: { type: 'integer' },
        account_name: { type: 'string' },
        pay_type: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        vehicle_year: { type: 'string' },
        vehicle_make: { type: 'string' },
        vehicle_model: { type: 'string' },
        tax_rate: { type: 'number' },
        tip_amount: { type: 'number' },
        tax_exempt: { type: 'boolean' },
        status: { type: 'string', enum: ['draft', 'completed', 'paid'] },
        notes: { type: 'string' },
        line_items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              line_type: { type: 'string', enum: ['labor', 'part'] },
              item_number: { type: 'string' },
              description: { type: 'string' },
              quantity: { type: 'number' },
              unit_price: { type: 'number' },
              taxable: { type: 'boolean' }
            },
            required: ['description', 'quantity', 'unit_price']
          }
        }
      },
      required: ['line_items']
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      var inv = await apiCall(actor, 'POST', '/api/invoices', pick(args, ['customer_name', 'account_id', 'account_name', 'pay_type', 'phone', 'email', 'vehicle_year', 'vehicle_make', 'vehicle_model', 'tax_rate', 'tip_amount', 'tax_exempt', 'status', 'notes', 'line_items']));
      return pick(inv, ['id', 'invoice_number', 'status', 'grand_total']);
    }
  },
  {
    name: 'update_invoice',
    description: 'Update an invoice (fields and/or line items). Needs edit_invoice permission. Replacing line_items replaces ALL items.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        customer_name: { type: 'string' },
        account_id: { type: 'integer' },
        account_name: { type: 'string' },
        pay_type: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        tax_rate: { type: 'number' },
        tip_amount: { type: 'number' },
        tax_exempt: { type: 'boolean' },
        status: { type: 'string', enum: ['draft', 'completed', 'paid'] },
        notes: { type: 'string' },
        line_items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              line_type: { type: 'string', enum: ['labor', 'part'] },
              item_number: { type: 'string' },
              description: { type: 'string' },
              quantity: { type: 'number' },
              unit_price: { type: 'number' },
              taxable: { type: 'boolean' }
            },
            required: ['description', 'quantity', 'unit_price']
          }
        }
      },
      required: ['id']
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      var r = await apiCall(actor, 'PUT', '/api/invoices/' + encodeURIComponent(args.id), pick(args, ['customer_name', 'account_id', 'account_name', 'pay_type', 'phone', 'email', 'tax_rate', 'tip_amount', 'tax_exempt', 'status', 'notes', 'line_items']));
      return { id: (r && r.id) || args.id, updated: true };
    }
  },
  {
    name: 'delete_invoice',
    description: 'CONFIRM FIRST — do not call until the user has explicitly approved. Permanently deletes an invoice. Needs delete_invoice permission.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      await apiCall(actor, 'DELETE', '/api/invoices/' + encodeURIComponent(args.id));
      return { id: args.id, deleted: true };
    }
  },
  {
    name: 'invoice_parts_report',
    description: 'Aggregated part usage from invoices for a month (YYYY-MM), used for month-end ordering. ' +
      'Needs view_invoices permission. Defaults to the current month. Read-only.',
    input_schema: { type: 'object', properties: { month: { type: 'string', description: 'YYYY-MM (optional, defaults to current month)' } } },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      args = args || {};
      var data = await apiCall(actor, 'GET', '/api/invoices/parts-report' + qs({ month: args.month }));
      return { month: data.month, items: pickAll(data.items, ['item_number', 'description', 'preferred_vendor', 'total_qty', 'invoice_count', 'avg_price']) };
    }
  },
  {
    name: 'list_deposits',
    description: 'List cash deposits (admins/managers see all; others see their own). Receipt images are not included. Read-only.',
    input_schema: { type: 'object', properties: {} },
    write: false,
    destructive: false,
    run: async function (actor) {
      var rows = await apiCall(actor, 'GET', '/api/deposits');
      return pickAll(rows, ['id', 'deposit_number', 'user_name', 'city_code', 'amount', 'pulsar_owed', 'total_expenses', 'deposit_date', 'created_at']);
    }
  },
  {
    name: 'delete_deposit',
    description: 'CONFIRM FIRST — do not call until the user has explicitly approved. Permanently deletes a deposit (and its receipts/expenses). Admins/managers only.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      await apiCall(actor, 'DELETE', '/api/deposits/' + encodeURIComponent(args.id));
      return { id: args.id, deleted: true };
    }
  },
  {
    name: 'list_reviews',
    description: 'List Google reviews with optional filters (location, rating, search, from/to dates, limit). ' +
      'Read-only. Requires the reviews database to be connected.',
    input_schema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'Exact location_name' },
        rating: { type: 'integer', description: '1-5' },
        search: { type: 'string', description: 'Match reviewer name or text' },
        from: { type: 'string', description: 'YYYY-MM-DD inclusive' },
        to: { type: 'string', description: 'YYYY-MM-DD inclusive' },
        limit: { type: 'integer', description: 'Default 50, max 5000' }
      }
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      args = args || {};
      var limit = (args.limit && args.limit > 0) ? args.limit : 50;
      var rows = await apiCall(actor, 'GET', '/api/reviews' + qs({ location: args.location, rating: args.rating, search: args.search, from: args.from, to: args.to, limit: limit }));
      return pickAll(rows, ['id', 'location_name', 'reviewer_name', 'rating', 'review_text', 'reply_text', 'review_date']);
    }
  },
  {
    name: 'review_stats',
    description: 'Google review stats: total count, average rating, five-star count, per-location breakdown, and rating distribution. ' +
      'With no filters this prefers Google official lifetime totals. Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        location: { type: 'string' },
        rating: { type: 'integer' },
        search: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' }
      }
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      args = args || {};
      var d = await apiCall(actor, 'GET', '/api/reviews/stats' + qs({ location: args.location, rating: args.rating, search: args.search, from: args.from, to: args.to }));
      return pick(d, ['total', 'avg_rating', 'five_star', 'by_location', 'distribution', 'filtered']);
    }
  },
  {
    name: 'list_users',
    description: 'List Nova users (id, name, email, role, active, city_codes). ' +
      'Use this to resolve a person name into the numeric user id required by ' +
      'assigned_to on tasks and work orders and by user_id on shifts. ' +
      'Optional q filters by name or email substring; active_only defaults true. Needs view_users.',
    input_schema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Filter by name or email substring (case-insensitive)' },
        active_only: { type: 'boolean', description: 'Only active users (default true)' }
      }
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      args = args || {};
      var rows = await apiCall(actor, 'GET', '/api/users');
      rows = Array.isArray(rows) ? rows : [];
      var activeOnly = args.active_only !== false;
      var q = (args.q || '').toString().trim().toLowerCase();
      var out = rows.filter(function (u) {
        if (activeOnly && !u.active) return false;
        if (!q) return true;
        var nm = (u.name || '').toLowerCase();
        var em = (u.email || '').toLowerCase();
        return nm.indexOf(q) !== -1 || em.indexOf(q) !== -1;
      });
      return pickAll(out, ['id', 'name', 'email', 'role', 'active', 'city_codes']);
    }
  },
  {
    name: 'list_shift_positions',
    description: 'List schedule positions (id, name, color, active). ' +
      'Use to resolve a position name into the position_id used when creating a shift. Needs view_schedule.',
    input_schema: { type: 'object', properties: {} },
    write: false,
    destructive: false,
    run: async function (actor) {
      var rows = await apiCall(actor, 'GET', '/api/schedule/positions');
      return pickAll(rows, ['id', 'name', 'color', 'active']);
    }
  },
  {
    name: 'list_my_shifts',
    description: 'List the current user published shifts in a date range (defaults to the next two weeks). ' +
      'Dates are YYYY-MM-DD. Needs view_schedule.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date YYYY-MM-DD (optional)' },
        to: { type: 'string', description: 'End date YYYY-MM-DD (optional)' }
      }
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      args = args || {};
      var rows = await apiCall(actor, 'GET', '/api/schedule/me' + qs({ from: args.from, to: args.to }));
      return pickAll(rows, ['id', 'shift_date', 'start_time', 'end_time', 'break_minutes', 'city_code', 'position_name', 'notes', 'status']);
    }
  },
  {
    name: 'list_shifts',
    description: 'List all scheduled shifts in a date range, optionally filtered by city_code (defaults to the current week). ' +
      'Dates are YYYY-MM-DD. Needs manage_schedule.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date YYYY-MM-DD (optional)' },
        to: { type: 'string', description: 'End date YYYY-MM-DD (optional)' },
        city: { type: 'string', description: 'City code filter (optional)' }
      }
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      args = args || {};
      var rows = await apiCall(actor, 'GET', '/api/schedule/shifts' + qs({ from: args.from, to: args.to, city: args.city }));
      return pickAll(rows, ['id', 'user_id', 'user_name', 'shift_date', 'start_time', 'end_time', 'break_minutes', 'city_code', 'position_name', 'status', 'notes']);
    }
  },
  {
    name: 'create_shift',
    description: 'Create a schedule shift for a user. Resolve user_id via list_users and position_id via list_shift_positions first. ' +
      'shift_date is YYYY-MM-DD; start_time and end_time are 24h HH:MM (end before start means it crosses midnight). ' +
      'The shift is live on the schedule as soon as it is saved (there is no draft step). Returns the shift plus any warn-but-allow conflicts. Needs manage_schedule.',
    input_schema: {
      type: 'object',
      properties: {
        user_id: { type: 'integer', description: 'Employee user id (from list_users)' },
        shift_date: { type: 'string', description: 'YYYY-MM-DD' },
        start_time: { type: 'string', description: '24h HH:MM' },
        end_time: { type: 'string', description: '24h HH:MM' },
        city_code: { type: 'string', description: 'City code (optional)' },
        position_id: { type: 'integer', description: 'Position id from list_shift_positions (optional)' },
        break_minutes: { type: 'integer', description: 'Unpaid break minutes (optional)' },
        notes: { type: 'string', description: 'Optional notes' }
      },
      required: ['user_id', 'shift_date', 'start_time', 'end_time']
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      args = args || {};
      var body = pick(args, ['user_id', 'shift_date', 'start_time', 'end_time', 'city_code', 'position_id', 'break_minutes', 'notes']);
      var data = await apiCall(actor, 'POST', '/api/schedule/shifts', body);
      return { shift: pick(data.shift || {}, ['id', 'user_id', 'user_name', 'shift_date', 'start_time', 'end_time', 'break_minutes', 'city_code', 'position_id', 'status', 'notes']), conflicts: data.conflicts || [] };
    }
  },
  {
    name: 'update_shift',
    description: 'Update an existing shift. Provide id plus the full shift fields (user_id, shift_date, start_time, end_time are required by the schedule API). ' +
      'Returns the updated shift plus any warn-but-allow conflicts. Needs manage_schedule.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        user_id: { type: 'integer' },
        shift_date: { type: 'string', description: 'YYYY-MM-DD' },
        start_time: { type: 'string', description: '24h HH:MM' },
        end_time: { type: 'string', description: '24h HH:MM' },
        city_code: { type: 'string' },
        position_id: { type: 'integer' },
        break_minutes: { type: 'integer' },
        notes: { type: 'string' }
      },
      required: ['id', 'user_id', 'shift_date', 'start_time', 'end_time']
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      args = args || {};
      var body = pick(args, ['user_id', 'shift_date', 'start_time', 'end_time', 'city_code', 'position_id', 'break_minutes', 'notes']);
      var data = await apiCall(actor, 'PUT', '/api/schedule/shifts/' + encodeURIComponent(args.id), body);
      return { shift: pick(data.shift || {}, ['id', 'user_id', 'user_name', 'shift_date', 'start_time', 'end_time', 'break_minutes', 'city_code', 'position_id', 'status', 'notes']), conflicts: data.conflicts || [] };
    }
  },
  {
    name: 'delete_shift',
    description: 'CONFIRM FIRST — do not call until the user has explicitly approved. Permanently deletes a scheduled shift. Needs manage_schedule.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id']
    },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      args = args || {};
      await apiCall(actor, 'DELETE', '/api/schedule/shifts/' + encodeURIComponent(args.id));
      return { ok: true, id: args.id };
    }
  },
  // ===================================================================
  // CUSTOMER FEEDBACK
  // ===================================================================
  {
    name: 'get_feedback',
    description: 'Get one customer feedback record by id, with its parsed details and current handling fields. Read-only. Needs view_feedback.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      var r = await apiCall(actor, 'GET', '/api/feedback/' + encodeURIComponent(args.id));
      var f = (r && r.feedback) || {};
      return pick(f, ['id', 'customer_name', 'city_code', 'city_name', 'tech_name', 'tech_user_id', 'category', 'severity', 'status', 'tech_at_fault', 'total_damages', 'refunded', 'followup_needed', 'followup_at', 'assigned_to', 'incident_text', 'ai_summary', 'is_resolved']);
    }
  },
  {
    name: 'update_feedback',
    description: 'Update handling fields on a customer feedback record. Assign a tech (tech_user_id - use list_users to resolve a name to an id), reassign owner (assigned_to), set status (new|complaint_pending|customer_contacted|in_progress), record total_damages / refunded / refunded_amount, or set a followup (followup_needed:true + followup_at as an ISO 8601 date-time; this texts AND emails the assigned manager when due). Set tech_at_fault (true/false) ONLY if the manager explicitly states fault. Does NOT close the record. Needs manage_feedback.',
    input_schema: { type: 'object', properties: {
      id: { type: 'integer' },
      tech_user_id: { type: 'integer' },
      assigned_to: { type: 'integer' },
      status: { type: 'string' },
      status_notes: { type: 'string' },
      total_damages: { type: 'number' },
      refunded: { type: 'boolean' },
      refunded_amount: { type: 'number' },
      tech_at_fault: { type: 'boolean' },
      followup_needed: { type: 'boolean' },
      followup_at: { type: 'string', description: 'ISO 8601 date-time, e.g. 2026-07-01T09:00' },
      followup_notes: { type: 'string' }
    }, required: ['id'] },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      var body = pick(args, ['tech_user_id', 'assigned_to', 'status', 'status_notes', 'total_damages', 'refunded', 'refunded_amount', 'tech_at_fault', 'followup_needed', 'followup_at', 'followup_notes']);
      var r = await apiCall(actor, 'PATCH', '/api/feedback/' + encodeURIComponent(args.id), body);
      return { id: args.id, updated: true, status: (r && r.feedback && r.feedback.status) };
    }
  },
  {
    name: 'add_feedback_note',
    description: 'Add a note to a customer feedback record timeline. Needs manage_feedback.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' }, body: { type: 'string' } }, required: ['id', 'body'] },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      await apiCall(actor, 'POST', '/api/feedback/' + encodeURIComponent(args.id) + '/notes', { body: args.body });
      return { id: args.id, noted: true };
    }
  },
  {
    name: 'resolve_feedback',
    description: 'CONFIRM FIRST - only when the manager explicitly says to close/resolve. Marks a feedback record resolved and closed. Requires a tech assigned and tech_at_fault set to true/false (and damages/refund recorded) or the API will reject it.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' }, resolved_notes: { type: 'string' } }, required: ['id'] },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      await apiCall(actor, 'PATCH', '/api/feedback/' + encodeURIComponent(args.id), { is_resolved: true, status: 'resolved', resolved_notes: args.resolved_notes });
      return { id: args.id, resolved: true };
    }
  },
  {
    name: 'clock_status',
    description: 'Get the current user time clock status: whether they are clocked in, on break, or out, plus how many punches today and minutes worked this week. Needs view_timeclock.',
    input_schema: { type: 'object', properties: {} },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      var s = await apiCall(actor, 'GET', '/api/timeclock/status');
      return {
        state: s.state,
        clocked_in_at: s.openEntry ? s.openEntry.clock_in_at : null,
        on_break: s.state === 'break',
        break_type: s.breakType || null,
        punches_today: (s.today || []).length,
        week_minutes: s.weekMinutes,
        week_start: s.weekStart
      };
    }
  },
  {
    name: 'clock_in',
    description: 'Clock the current user IN on the Nova time clock right now, at the current server time. If they have a published shift today, lateness is recorded automatically. Fails if they are already clocked in. This is a payroll action recorded under the user own account, so only call it when the user has clearly asked to clock in; never on your own initiative. Needs view_timeclock.',
    input_schema: { type: 'object', properties: {} },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      var e = await apiCall(actor, 'POST', '/api/timeclock/clock-in');
      return { id: e.id, clocked_in_at: e.clock_in_at, city_code: e.city_code, late_minutes: e.late_minutes, status: e.status };
    }
  },
  {
    name: 'clock_out',
    description: 'Clock the current user OUT on the Nova time clock right now, at the current server time. Any open break is auto-ended and the minutes worked are totaled. Fails if they are not clocked in. This is a payroll action recorded under the user own account, so only call it when the user has clearly asked to clock out; never on your own initiative. Needs view_timeclock.',
    input_schema: { type: 'object', properties: {} },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      var e = await apiCall(actor, 'POST', '/api/timeclock/clock-out');
      return { id: e.id, clocked_in_at: e.clock_in_at, clocked_out_at: e.clock_out_at, worked_minutes: e.worked_minutes, status: e.status };
    }
  },

  // ===================================================================
  // ASSET / EQUIPMENT TRACKER
  // The tracker scopes managers to their OWN cities (deliberately, unlike
  // every other module). A user with no cities and no home city gets an
  // EMPTY list rather than an error, so assetScopeNote turns that silence
  // into a real explanation instead of letting the model report "none".
  // ===================================================================
  {
    name: 'list_equipment',
    description: 'List tracked equipment (tools, gear, uniforms) with filters. Shows what exists, where it is, and who holds it. Read-only. Needs view_assets. Managers only see their own cities here.',
    input_schema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '3-letter city code, e.g. ORL' },
        user_id: { type: 'integer', description: 'Only equipment held by this user (use list_users to resolve a name)' },
        category: { type: 'string', enum: ['tool', 'gear', 'uniform'] },
        status: { type: 'string', enum: ['assigned', 'in_stock', 'in_transit', 'needs_repair', 'awaiting_return', 'lost'] },
        asset_type_id: { type: 'integer' },
        q: { type: 'string', description: 'Free text over name, asset tag, serial number, holder name' },
        page: { type: 'integer' },
        page_size: { type: 'integer', description: 'Default 25, max 500' }
      }
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      var r = await apiCall(actor, 'GET', '/api/assets' + qs({
        city: args.city, user_id: args.user_id, category: args.category, status: args.status,
        asset_type_id: args.asset_type_id, q: args.q, page: args.page, page_size: args.page_size
      }));
      var out = {
        items: pickAll(r.items, ['row_id', 'kind', 'asset_id', 'asset_type_id', 'name', 'category', 'asset_tag', 'serial_number', 'city_code', 'holder_name', 'assigned_user_id', 'held_since', 'status', 'condition', 'qty', 'unit_cost']),
        total: r.total, total_value: r.value, page: r.page, page_size: r.page_size
      };
      if (!out.items.length) {
        var note = await assetScopeNote(actor);
        if (note) out.note = note;
      }
      return out;
    }
  },
  {
    name: 'equipment_stats',
    description: 'Headline equipment numbers: how many items are tracked, assigned, in stock, needing attention or lost, and the total value. Read-only. Needs view_assets.',
    input_schema: { type: 'object', properties: {} },
    write: false,
    destructive: false,
    run: async function (actor) {
      return await apiCall(actor, 'GET', '/api/assets/stats');
    }
  },
  {
    name: 'search_equipment',
    description: 'Find a specific serialized item by asset tag, serial number or name. Returns up to 20 matches. Read-only. Needs view_assets. Only finds serialized units, not counted shelf stock.',
    input_schema: {
      type: 'object',
      properties: { q: { type: 'string', description: 'At least 2 characters' } },
      required: ['q']
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      var term = String(args.q || '').trim();
      if (term.length < 2) throw new Error('Search needs at least 2 characters.');
      var rows = await apiCall(actor, 'GET', '/api/assets/search' + qs({ q: term }));
      return pickAll(rows, ['id', 'name', 'asset_tag', 'serial_number', 'status', 'city_code', 'holder_name']);
    }
  },
  {
    name: 'list_equipment_locations',
    description: 'Every location (city) with its equipment totals: items held, out with techs, on the shelf, how many are below minimum, and shelf value. Use this first when asked what is in stock anywhere. Read-only. Needs view_assets.',
    input_schema: { type: 'object', properties: {} },
    write: false,
    destructive: false,
    run: async function (actor) {
      var rows = await apiCall(actor, 'GET', '/api/assets/locations');
      if (!Array.isArray(rows) || !rows.length) {
        var note = await assetScopeNote(actor);
        if (note) return { locations: [], note: note };
      }
      return { locations: pickAll(rows, ['code', 'name', 'items', 'out_with_techs', 'on_shelf', 'below_min', 'awaiting_return', 'value']) };
    }
  },
  {
    name: 'get_equipment_location',
    description: 'Stock at ONE location, line by line for every equipment type, including how many are on the shelf, the minimum, and whether it is below minimum. This answers "do we have X in <city>". Read-only. Needs view_assets.',
    input_schema: {
      type: 'object',
      properties: { city_code: { type: 'string', description: '3-letter city code, e.g. ORL' } },
      required: ['city_code']
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      var rows = await apiCall(actor, 'GET', '/api/assets/locations/' + encodeURIComponent(String(args.city_code || '').toUpperCase()));
      return pickAll(rows, ['asset_type_id', 'name', 'category', 'serialized', 'on_shelf', 'min_qty', 'below_min', 'units_in_stock', 'counted_on_hand', 'out_with_techs', 'awaiting_return', 'replaced_12mo', 'unit_cost', 'vendor_name', 'item_number', 'shelf_value']);
    }
  },
  {
    name: 'list_equipment_types',
    description: 'The Equipment List: every type of equipment the company tracks, with company-wide counts and the reorder minimum. This is the equipment catalog, NOT the parts price book. Read-only. Needs view_assets.',
    input_schema: { type: 'object', properties: {} },
    write: false,
    destructive: false,
    run: async function (actor) {
      var rows = await apiCall(actor, 'GET', '/api/assets/types');
      return pickAll(rows, ['id', 'name', 'category', 'serialized', 'expected_life_months', 'unit_cost', 'vendor_name', 'item_number', 'manufacturer', 'counted_on_hand', 'units_in_stock', 'out_with_techs', 'replaced_12mo', 'min_total']);
    }
  },
  {
    name: 'get_tech_equipment',
    description: 'Everything one technician currently holds, plus their return history, signed acknowledgements and replacement stats. Read-only. A user can always read their own; reading anyone else needs manage_assets.',
    input_schema: {
      type: 'object',
      properties: { user_id: { type: 'integer', description: 'Use list_users to resolve a name to an id' } },
      required: ['user_id']
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      var r = await apiCall(actor, 'GET', '/api/assets/by-user/' + encodeURIComponent(args.user_id));
      return {
        user: pick(r.user || {}, ['id', 'name', 'role', 'home_city', 'title', 'hire_date']),
        stats: r.stats,
        pending_acks: r.pending_acks,
        current: pickAll(r.current, ['id', 'asset_type_id', 'name', 'category', 'asset_tag', 'serial_number', 'qty', 'city_code', 'issued_at', 'status', 'condition_out', 'ack_status', 'ack_number']),
        recent_returns: pickAll((r.history || []).slice(0, 25), ['id', 'name', 'asset_tag', 'qty', 'issued_at', 'returned_at', 'returned_reason', 'condition_in'])
      };
    }
  },
  {
    name: 'my_equipment',
    description: 'What the CURRENT user is holding, any acknowledgements waiting for their signature, and their open replacement requests. Read-only. Needs view_assets.',
    input_schema: { type: 'object', properties: {} },
    write: false,
    destructive: false,
    run: async function (actor) {
      var r = await apiCall(actor, 'GET', '/api/assets/mine');
      return {
        items: pickAll(r.items, ['id', 'asset_type_id', 'name', 'category', 'asset_tag', 'serial_number', 'qty', 'city_code', 'issued_at', 'status', 'ack_status', 'ack_number']),
        pending_acks: pickAll(r.pending_acks, ['id', 'ack_number', 'created_at']),
        open_requests: pickAll(r.open_requests, ['id', 'request_number', 'status', 'created_at', 'decided_at', 'decision_notes', 'po_number'])
      };
    }
  },
  {
    name: 'list_equipment_requests',
    description: 'Replacement requests for equipment. A technician sees only their own; a manager sees their cities. Read-only. Needs view_assets. Approving a request is deliberately NOT available here - it opens a real purchase order and must be done in Nova.',
    input_schema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['pending', 'approved', 'denied', 'cancelled', 'fulfilled'] } }
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      var rows = await apiCall(actor, 'GET', '/api/assets/requests' + qs({ status: args.status }));
      return (Array.isArray(rows) ? rows : []).map(function (r) {
        var o = pick(r, ['id', 'request_number', 'user_id', 'user_name', 'city_code', 'kind', 'status', 'notes', 'decided_by_name', 'decided_at', 'decision_notes', 'po_number', 'created_at']);
        o.lines = pickAll(r.lines, ['asset_type_id', 'name', 'qty', 'reason', 'notes', 'prior_replacements']);
        return o;
      });
    }
  },
  {
    name: 'list_equipment_transfers',
    description: 'Equipment transfers between locations, most recent first, including anything still in transit. Read-only. Needs view_assets.',
    input_schema: { type: 'object', properties: {} },
    write: false,
    destructive: false,
    run: async function (actor) {
      var rows = await apiCall(actor, 'GET', '/api/assets/transfers');
      return (Array.isArray(rows) ? rows : []).map(function (r) {
        var o = pick(r, ['id', 'transfer_number', 'from_city', 'to_city', 'status', 'reason', 'notes', 'sent_by_name', 'sent_at', 'received_by_name', 'received_at']);
        o.lines = pickAll(r.lines, ['asset_type_id', 'label', 'qty', 'asset_tag', 'serial_number']);
        return o;
      });
    }
  },
  {
    name: 'create_equipment_transfer',
    description: 'CONFIRM FIRST - this physically moves stock out of the sending location immediately. Read back the items, the quantities and both cities and get an explicit yes before calling. Sends equipment from one location to another; it stays in transit until the receiving location confirms. Needs manage_assets, and you can only send FROM your own cities.',
    input_schema: {
      type: 'object',
      properties: {
        from_city: { type: 'string', description: '3-letter city code to send from' },
        to_city: { type: 'string', description: '3-letter city code to send to' },
        lines: {
          type: 'array',
          description: 'Items to send. Each: { asset_id } for a specific serialized unit, OR { asset_type_id, qty } for counted stock.',
          items: {
            type: 'object',
            properties: {
              asset_id: { type: 'integer', description: 'A specific serialized unit. Quantity is always 1.' },
              asset_type_id: { type: 'integer', description: 'A non-serialized equipment type' },
              qty: { type: 'integer', description: 'Defaults to 1' }
            }
          }
        },
        reason: { type: 'string' },
        notes: { type: 'string' }
      },
      required: ['from_city', 'to_city', 'lines']
    },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      var t = await apiCall(actor, 'POST', '/api/assets/transfers', {
        from_city: String(args.from_city || '').toUpperCase(),
        to_city: String(args.to_city || '').toUpperCase(),
        lines: args.lines, reason: args.reason, notes: args.notes
      });
      return pick(t, ['id', 'transfer_number', 'from_city', 'to_city', 'status', 'sent_at']);
    }
  },
  {
    name: 'receive_equipment_transfer',
    description: 'CONFIRM FIRST - confirm with the user before calling. Marks an in-transit transfer as received, which puts the equipment into the destination location stock. Only someone in the RECEIVING city can do this. Needs manage_assets.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'The numeric transfer id, not the TR- number' } },
      required: ['id']
    },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      var id = parseInt(args.id, 10);
      if (!id) throw new Error('A numeric transfer id is required.');
      await apiCall(actor, 'POST', '/api/assets/transfers/' + id + '/receive');
      return { id: id, received: true };
    }
  },
  {
    name: 'set_equipment_stock',
    description: 'CONFIRM FIRST - this overwrites a shelf count and is logged with the reason. Confirm the location, the item and the new number with the user before calling. Sets the on-hand count for one equipment type at one location. The quantity is the NEW TOTAL, not an amount to add. Needs manage_assets, and the location must be one of your cities.',
    input_schema: {
      type: 'object',
      properties: {
        city_code: { type: 'string', description: '3-letter city code' },
        asset_type_id: { type: 'integer' },
        qty_on_hand: { type: 'integer', description: 'The new total count. Cannot be negative.' },
        note: { type: 'string', description: 'Why the count is changing. Required.' }
      },
      required: ['city_code', 'asset_type_id', 'qty_on_hand', 'note']
    },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      if (!args.note || !String(args.note).trim()) throw new Error('A note explaining the count change is required.');
      var r = await apiCall(actor, 'PUT', '/api/assets/locations/' + encodeURIComponent(String(args.city_code || '').toUpperCase()) + '/stock', {
        asset_type_id: args.asset_type_id, qty_on_hand: args.qty_on_hand, note: args.note
      });
      return { city_code: String(args.city_code || '').toUpperCase(), asset_type_id: args.asset_type_id, qty_on_hand: r.qty_on_hand, changed_by: r.delta };
    }
  },

  // ===================================================================
  // PTO / TIME OFF
  // ===================================================================
  {
    name: 'my_pto',
    description: 'The current user PTO balance in hours, how it accrues, whether they are eligible yet, their recent ledger entries and their own requests. Read-only, open to any signed-in user.',
    input_schema: { type: 'object', properties: {} },
    write: false,
    destructive: false,
    run: async function (actor) {
      var r = await apiCall(actor, 'GET', '/api/pto/me');
      return {
        balance_hours: r.balance_hours, accrual_monthly_hours: r.accrual_monthly_hours,
        accrual_days_per_year: r.accrual_days_per_year, accrues: r.accrues, exempt: r.exempt,
        employment_type: r.employment_type, pay_type: r.pay_type, tenure_years: r.tenure_years,
        eligible_date: r.eligible_date, eligible_now: r.eligible_now,
        requests: pickAll((r.requests || []).slice(0, 20), ['id', 'start_date', 'end_date', 'hours', 'type', 'paid', 'status', 'paid_days', 'unpaid_days', 'off_days', 'created_at']),
        recent_ledger: pickAll((r.ledger || []).slice(0, 20), ['entry_date', 'kind', 'amount_hours', 'description'])
      };
    }
  },
  {
    name: 'list_pto_approvals',
    description: 'PTO requests waiting on the CURRENT user to approve, oldest first, including how many other people are already off on those days and whether that breaks the coverage cap. Returns an empty list for someone who approves for nobody. Read-only.',
    input_schema: { type: 'object', properties: {} },
    write: false,
    destructive: false,
    run: async function (actor) {
      var rows = await apiCall(actor, 'GET', '/api/pto/approvals');
      return pickAll(rows, ['id', 'user_id', 'user_name', 'start_date', 'end_date', 'hours', 'type', 'paid', 'status', 'paid_days', 'unpaid_days', 'off_days', 'coverage_used', 'coverage_cap', 'coverage_over', 'retroactive', 'created_at']);
    }
  },
  {
    name: 'list_team_pto',
    description: 'PTO balances for the people the current user manages (everyone, for an admin), with the start date of any request they have pending. Read-only. Needs manage_pto. Does not include the caller themselves - use my_pto for that.',
    input_schema: { type: 'object', properties: {} },
    write: false,
    destructive: false,
    run: async function (actor) {
      var rows = await apiCall(actor, 'GET', '/api/pto/team');
      return pickAll(rows, ['id', 'name', 'title', 'pay_type', 'balance_hours', 'hire_date', 'exempt', 'pending']);
    }
  },
  {
    name: 'get_pto_ledger',
    description: 'The PTO ledger for one person on the current user team: every accrual, use and adjustment, newest first. Read-only. Needs manage_pto and they must be in your reporting line.',
    input_schema: {
      type: 'object',
      properties: { user_id: { type: 'integer', description: 'Use list_users or list_team_pto to resolve a name' } },
      required: ['user_id']
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      var rows = await apiCall(actor, 'GET', '/api/pto/team/' + encodeURIComponent(args.user_id) + '/ledger');
      return pickAll(rows, ['id', 'entry_date', 'kind', 'amount_hours', 'description', 'created_at']);
    }
  },
  {
    name: 'approve_pto_request',
    description: 'CONFIRM FIRST - this emails and texts the employee, deducts paid hours from their balance and marks the days on the schedule. Read the dates and hours back to the user and get an explicit yes before calling. If it comes back saying coverage would be exceeded, tell the user how many people are already off and ask whether to override, then call again with override_reason.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'The PTO request id from list_pto_approvals' },
        override_reason: { type: 'string', description: 'Only when going over the coverage cap on purpose' }
      },
      required: ['id']
    },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      try {
        var r = await apiCall(actor, 'POST', '/api/pto/requests/' + encodeURIComponent(args.id) + '/approve', { override_reason: args.override_reason });
        return { id: args.id, approved: true, coverage_override: !!r.coverage_override };
      } catch (e) {
        if (String(e.message) === 'coverage_override_required') {
          throw new Error('Approving this would put more people off than the coverage cap allows. Tell the user and ask whether to override; if they agree, call again with override_reason.');
        }
        throw e;
      }
    }
  },
  {
    name: 'deny_pto_request',
    description: 'CONFIRM FIRST - this emails and texts the employee. Confirm with the user before calling. Denies a pending PTO request. NOTE: if the request is in cancel_requested state, denying it does NOT deny the time off - it refuses the cancellation and puts the PTO back to approved.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        reason: { type: 'string', description: 'Shown to the employee' }
      },
      required: ['id']
    },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      var r = await apiCall(actor, 'POST', '/api/pto/requests/' + encodeURIComponent(args.id) + '/deny', { reason: args.reason });
      return { id: args.id, denied: true, resulting_status: r.status || 'denied' };
    }
  },

  // ===================================================================
  // TIME CLOCK (reads - punching in and out already has its own tools)
  // ===================================================================
  {
    name: 'get_my_timesheet',
    description: 'The current user own timesheet for a week: every punch, breaks, and the split into regular, overtime, holiday and vacation minutes. Defaults to this week. Read-only, self only.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD, defaults to Monday of this week' },
        to: { type: 'string', description: 'YYYY-MM-DD, defaults to from plus 6 days' }
      }
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      var r = await apiCall(actor, 'GET', '/api/timeclock/timesheet' + qs({ from: args.from, to: args.to }));
      return {
        from: r.from, to: r.to,
        breakdown_minutes: r.breakdown,
        approval_status: (r.approval && r.approval.status) || 'open',
        entries: pickAll(r.entries, ['id', 'clock_in_at', 'clock_out_at', 'worked_minutes', 'late_minutes', 'status', 'city_code', 'source'])
      };
    }
  },
  {
    name: 'who_is_clocked_in',
    description: 'Everyone currently on the clock right now, who is on break, and any entries flagged or auto-closed in the last 30 days. Read-only. Needs manage_timeclock.',
    input_schema: { type: 'object', properties: {} },
    write: false,
    destructive: false,
    run: async function (actor) {
      var r = await apiCall(actor, 'GET', '/api/timeclock/board');
      return {
        clocked_in: pickAll(r.open, ['id', 'user_id', 'user_name', 'city_code', 'clock_in_at', 'on_break_type', 'on_break_since', 'late_minutes']),
        needs_attention: pickAll(r.flags, ['id', 'user_id', 'user_name', 'clock_in_at', 'clock_out_at', 'status', 'worked_minutes'])
      };
    }
  },
  {
    name: 'get_week_hours',
    description: 'Hours for every employee for one week: total minutes and the regular / overtime / holiday / vacation split, plus where each timesheet sits in approval. Read-only. Needs manage_timeclock. Individual punches are left out on purpose - use get_my_timesheet or the Time Clock screen for those.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD, defaults to Monday of this week' },
        to: { type: 'string', description: 'YYYY-MM-DD, defaults to from plus 6 days. Keep this to about a week - the underlying report is heavy.' }
      }
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      var r = await apiCall(actor, 'GET', '/api/timeclock/admin' + qs({ from: args.from, to: args.to }));
      return {
        from: r.from, to: r.to,
        users: (r.users || []).map(function (u) {
          return {
            user_id: u.user && u.user.id, name: u.user && u.user.name, pay_type: u.user && u.user.pay_type,
            total_minutes: u.minutes, breakdown_minutes: u.breakdown,
            approval_status: (u.approval && u.approval.status) || 'open',
            entry_count: (u.entries || []).length
          };
        })
      };
    }
  },

  // ===================================================================
  // SCHEDULE (reads + the two bulk week actions)
  // ===================================================================
  {
    name: 'get_city_schedule',
    description: 'Published shifts for a date range, by city - who is working, when, and in what position. Defaults to the current week and the next. This is the tool for "who is working today". Read-only. Needs view_schedule.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD, defaults to Monday of this week' },
        to: { type: 'string', description: 'YYYY-MM-DD, defaults to from plus 13 days' },
        city: { type: 'string', description: '3-letter city code' }
      }
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      var r = await apiCall(actor, 'GET', '/api/schedule/city' + qs({ from: args.from, to: args.to, city: args.city }));
      return {
        cities: pickAll(r.cities, ['code', 'name']),
        shifts: pickAll(r.shifts, ['id', 'user_id', 'user_name', 'city_code', 'city_name', 'shift_date', 'start_time', 'end_time', 'break_minutes', 'position_name', 'notes'])
      };
    }
  },
  {
    name: 'list_scheduled_users',
    description: 'Who has a shift on each day in a range, including drafts. Lighter than the full schedule when you only need names and days. Read-only. Needs manage_schedule.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD, defaults to Monday of this week' },
        to: { type: 'string', description: 'YYYY-MM-DD, defaults to from plus 6 days' },
        city: { type: 'string' }
      }
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      var rows = await apiCall(actor, 'GET', '/api/schedule/scheduled-users' + qs({ from: args.from, to: args.to, city: args.city }));
      return pickAll(rows, ['user_id', 'name', 'pulsar_name', 'shift_date']);
    }
  },
  {
    name: 'get_my_schedule_scope',
    description: 'Which cities the current user can schedule for. Returns all_cities true when they are not restricted. Useful before reporting that a city has no shifts. Read-only. Needs manage_schedule.',
    input_schema: { type: 'object', properties: {} },
    write: false,
    destructive: false,
    run: async function (actor) {
      var r = await apiCall(actor, 'GET', '/api/schedule/my-scope');
      return { all_cities: r.cities === null, cities: r.cities || [] };
    }
  },
  {
    name: 'copy_schedule_week',
    description: 'CONFIRM FIRST and never call twice. Copies a whole week of shifts onto another week; the copies are live on the schedule immediately. There is NO duplicate check and NO undo - running it twice creates a second copy of every shift, which then has to be deleted by hand. Confirm both Mondays with the user, and if you are unsure whether it already ran, check the target week with get_city_schedule first. Needs manage_schedule.',
    input_schema: {
      type: 'object',
      properties: {
        source_monday: { type: 'string', description: 'YYYY-MM-DD, the Monday of the week to copy FROM' },
        target_monday: { type: 'string', description: 'YYYY-MM-DD, the Monday of the week to copy TO' },
        city: { type: 'string', description: 'Optional, limits it to one city' }
      },
      required: ['source_monday', 'target_monday']
    },
    write: true,
    destructive: true,
    run: async function (actor, args) {
      var r = await apiCall(actor, 'POST', '/api/schedule/copy-week', {
        source_monday: args.source_monday, target_monday: args.target_monday, city: args.city
      });
      return { copied: r.copied, target_monday: args.target_monday, note: 'The copied shifts are live on the schedule now.' };
    }
  },

  // ===================================================================
  // VEHICLE INSPECTIONS
  // ===================================================================
  {
    name: 'get_inspection_compliance',
    description: 'The monthly vehicle inspection grid: every vehicle, its driver, and whether it has been inspected this month. A vehicle with no inspection id has not been done. This answers "who is overdue on inspections". Read-only. Needs view_inspections.',
    input_schema: {
      type: 'object',
      properties: {
        month: { type: 'string', description: 'YYYY-MM, defaults to the current month' },
        city_code: { type: 'string', description: '3-letter code. Only applies for admins and managers.' }
      }
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      var r = await apiCall(actor, 'GET', '/api/inspections/compliance' + qs({ month: args.month, city_code: args.city_code }));
      return {
        month: r.month, cutoff_day: r.cutoff_day, current_month: r.current_month,
        vehicles: pickAll(r.vehicles, ['vehicle_id', 'year', 'make_model', 'license_plate', 'city_code', 'driver_name', 'inspector_name', 'inspection_id', 'inspection_number', 'status', 'overall_result', 'inspected_at', 'inspection_exempt', 'inspection_exempt_reason'])
      };
    }
  },
  {
    name: 'list_inspections',
    description: 'Submitted vehicle inspections. Give a month or a vehicle - without one this would return every inspection ever recorded. A technician only sees their own. Read-only. Needs view_inspections.',
    input_schema: {
      type: 'object',
      properties: {
        month: { type: 'string', description: 'YYYY-MM' },
        vehicle_id: { type: 'integer' }
      }
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      if (!args.month && !args.vehicle_id) throw new Error('Give a month (YYYY-MM) or a vehicle_id - otherwise this returns every inspection ever submitted.');
      var rows = await apiCall(actor, 'GET', '/api/inspections' + qs({ month: args.month, vehicle_id: args.vehicle_id }));
      return pickAll(rows, ['id', 'inspection_number', 'vehicle_id', 'year', 'make_model', 'license_plate', 'period_month', 'city_code', 'mileage', 'status', 'overall_result', 'submitted_by_name', 'photo_count', 'created_at']);
    }
  },
  {
    name: 'get_inspection',
    description: 'One vehicle inspection in full, including every checklist answer and any comments. Photo captions are listed but the images are not. Read-only. Needs view_inspections, and a technician can only open their own.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'The numeric inspection id, not the inspection number' } },
      required: ['id']
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      var id = parseInt(args.id, 10);
      if (!id) throw new Error('A numeric inspection id is required.');
      var r = await apiCall(actor, 'GET', '/api/inspections/' + id);
      return {
        inspection: pick(r, ['id', 'inspection_number', 'vehicle_id', 'year', 'make_model', 'license_plate', 'period_month', 'city_code', 'mileage', 'status', 'overall_result', 'notes', 'submitted_by_name', 'reviewer_name', 'reviewed_at', 'created_at']),
        driver: r.driver ? pick(r.driver, ['id', 'name']) : null,
        items: pickAll(r.items, ['item_key', 'label', 'answer', 'color', 'comment']),
        photo_count: (r.photos || []).length,
        photo_captions: (r.photos || []).map(function (p) { return p.caption || p.name; }).filter(Boolean),
        followup_items: r.followup_items
      };
    }
  },

  // ===================================================================
  // REFUNDS
  // ===================================================================
  {
    name: 'list_refunds',
    description: 'Invoice refunds and where each one sits: requested, approved, processed, rejected or voided. Someone who cannot approve refunds only sees their own. Read-only. Needs view_invoices. Approving a refund is deliberately not available here - it moves money and must be done in Nova.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['requested', 'approved', 'processed', 'rejected', 'voided'] },
        invoice_id: { type: 'integer' },
        limit: { type: 'integer', description: 'Default 50' }
      }
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      var rows = await apiCall(actor, 'GET', '/api/refunds' + qs({ status: args.status, invoice_id: args.invoice_id }));
      var lim = parseInt(args.limit, 10) || 50;
      var all = Array.isArray(rows) ? rows : [];
      var out = {
        refunds: pickAll(all.slice(0, lim), ['id', 'refund_number', 'invoice_id', 'invoice_number', 'amount', 'status', 'method_label', 'reason_label', 'reason_notes', 'customer_name', 'city_code', 'requested_by_name', 'requested_at', 'approved_by_name', 'approved_at', 'refund_date']),
        total: all.length
      };
      if (all.length > lim) out.note = 'Showing the ' + lim + ' most recent of ' + all.length + '.';
      return out;
    }
  },
  {
    name: 'get_refund_summary',
    description: 'This month refund picture: how many are waiting to be approved, how many are approved but not yet processed, the dollars refunded, the dollars invoiced, and the refund rate. Read-only. Needs view_invoices.',
    input_schema: { type: 'object', properties: {} },
    write: false,
    destructive: false,
    run: async function (actor) {
      return await apiCall(actor, 'GET', '/api/refunds/summary');
    }
  },

  // ===================================================================
  // CUSTOMER FEEDBACK (the list the other feedback tools were missing)
  // ===================================================================
  {
    name: 'list_feedback',
    description: 'Customer feedback and complaints, unresolved first. Use this to find the record id that get_feedback and update_feedback need. Read-only. Needs view_feedback. The original customer email body is deliberately left out - open the record in Nova to read it.',
    input_schema: {
      type: 'object',
      properties: {
        city: { type: 'string' },
        category: { type: 'string' },
        severity: { type: 'string' },
        status: { type: 'string' },
        tech: { type: 'integer', description: 'Technician user id' },
        resolved: { type: 'boolean' },
        from: { type: 'string', description: 'YYYY-MM-DD, on or after' },
        to: { type: 'string', description: 'YYYY-MM-DD, on or before' },
        search: { type: 'string', description: 'Matches customer name or the incident text' },
        limit: { type: 'integer', description: 'Default 25, max 100' },
        offset: { type: 'integer' }
      }
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      var lim = Math.min(parseInt(args.limit, 10) || 25, 100);
      var r = await apiCall(actor, 'GET', '/api/feedback' + qs({
        city: args.city, category: args.category, severity: args.severity, status: args.status,
        tech: args.tech, resolved: (args.resolved === true ? 'true' : (args.resolved === false ? 'false' : '')),
        from: args.from, to: args.to, search: args.search, limit: lim, offset: args.offset
      }));
      return {
        feedback: pickAll(r.feedback, ['id', 'customer_name', 'city_code', 'city_name', 'category', 'severity', 'status', 'is_resolved', 'tech_name', 'tech_user_id', 'tech_at_fault', 'assigned_name', 'total_damages', 'refunded_amount', 'followup_needed', 'followup_at', 'ai_summary', 'received_at', 'last_interaction_at', 'needs_review']),
        total: r.total
      };
    }
  },

  // ===================================================================
  // LOOKUPS the purchasing and quoting tools were missing
  // ===================================================================
  {
    name: 'list_cities',
    description: 'Every active city with its 3-letter code. Use this to turn a city name the user said into the code the other tools need. Read-only, open to any signed-in user.',
    input_schema: { type: 'object', properties: {} },
    write: false,
    destructive: false,
    run: async function (actor) {
      var rows = await apiCall(actor, 'GET', '/api/cities');
      return (Array.isArray(rows) ? rows : []).map(function (c) {
        return { id: c.id, name: c.name, code: (c.code || '').trim(), invoice_prefix: c.invoice_prefix };
      });
    }
  },
  {
    name: 'list_my_cities',
    description: 'The cities the current user is assigned to. Note that admins, managers, and anyone with no assignment at all get the full list. Read-only.',
    input_schema: { type: 'object', properties: {} },
    write: false,
    destructive: false,
    run: async function (actor) {
      var rows = await apiCall(actor, 'GET', '/api/cities/mine');
      return (Array.isArray(rows) ? rows : []).map(function (c) {
        return { id: c.id, name: c.name, code: (c.code || '').trim() };
      });
    }
  },
  {
    name: 'list_shipping_addresses',
    description: 'Ship-to addresses for one city, for putting on a purchase order. Read-only, open to any signed-in user.',
    input_schema: {
      type: 'object',
      properties: { city_code: { type: 'string', description: '3-letter city code' } },
      required: ['city_code']
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      var code = String(args.city_code || '').trim().toUpperCase();
      if (!code) throw new Error('A city code is required - without one this returns nothing.');
      var rows = await apiCall(actor, 'GET', '/api/addresses' + qs({ city_code: code }));
      return pickAll(rows, ['id', 'city_code', 'name', 'address']);
    }
  },
  {
    name: 'get_deposit',
    description: 'One deposit with its expense lines. Receipt photos are counted but not returned. Read-only. Needs view_deposits, and anyone below manager only sees their own.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'The numeric deposit id, not the DEP- number' } },
      required: ['id']
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      var id = parseInt(args.id, 10);
      if (!id) throw new Error('A numeric deposit id is required.');
      var d = await apiCall(actor, 'GET', '/api/deposits/' + id);
      return {
        deposit: pick(d, ['id', 'deposit_number', 'user_id', 'user_name', 'city_code', 'amount', 'pulsar_owed', 'deposit_date', 'period_start', 'period_end', 'notes', 'ai_edited', 'created_at']),
        receipt_count: (d.receipts || []).length,
        expenses: (d.expenses || []).map(function (e) {
          return { id: e.id, description: e.description, amount: e.amount, has_receipt: !!e.receipt_image, no_receipt: e.no_receipt, no_receipt_reason: e.no_receipt_reason };
        })
      };
    }
  },
  {
    name: 'list_task_templates',
    description: 'Reusable task checklists (onboarding, offboarding and similar) that can prefill a task and its subtasks. Read-only. Needs view_tasks.',
    input_schema: {
      type: 'object',
      properties: { include_inactive: { type: 'boolean' } }
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      var rows = await apiCall(actor, 'GET', '/api/task-templates' + qs({ all: args.include_inactive ? '1' : '' }));
      return pickAll(rows, ['id', 'name', 'description', 'priority', 'category', 'active', 'step_count']);
    }
  },
  {
    name: 'get_task_template',
    description: 'One task template with its steps in order, including who each step defaults to. Read-only. Needs view_tasks.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id']
    },
    write: false,
    destructive: false,
    run: async function (actor, args) {
      var id = parseInt(args.id, 10);
      if (!id) throw new Error('A numeric template id is required.');
      var t = await apiCall(actor, 'GET', '/api/task-templates/' + id);
      var o = pick(t, ['id', 'name', 'description', 'priority', 'category', 'active']);
      o.steps = pickAll(t.steps, ['id', 'title', 'position', 'default_assignee_id', 'assignee_name']);
      return o;
    }
  }
];

function toAnthropicTools() {
  return TOOLS.map(function (t) {
    return { name: t.name, description: t.description, input_schema: t.input_schema };
  });
}

function getTool(name) {
  for (var i = 0; i < TOOLS.length; i++) {
    if (TOOLS[i].name === name) return TOOLS[i];
  }
  return null;
}

module.exports = { TOOLS: TOOLS, toAnthropicTools: toAnthropicTools, getTool: getTool };
