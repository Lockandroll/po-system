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
    { id: actor.id, email: actor.email, name: actor.name, role: actor.role },
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
    description: 'Submit an employee suggestion. Any authenticated user can submit. Notifies admins/managers. ' +
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
    destructive: false,
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
      'Set publish true to publish immediately, otherwise it is saved as a draft. Returns the shift plus any warn-but-allow conflicts. Needs manage_schedule.',
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
        notes: { type: 'string', description: 'Optional notes' },
        publish: { type: 'boolean', description: 'Publish immediately (default false = draft)' }
      },
      required: ['user_id', 'shift_date', 'start_time', 'end_time']
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      args = args || {};
      var body = pick(args, ['user_id', 'shift_date', 'start_time', 'end_time', 'city_code', 'position_id', 'break_minutes', 'notes', 'publish']);
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
        notes: { type: 'string' },
        publish: { type: 'boolean' }
      },
      required: ['id', 'user_id', 'shift_date', 'start_time', 'end_time']
    },
    write: true,
    destructive: false,
    run: async function (actor, args) {
      args = args || {};
      var body = pick(args, ['user_id', 'shift_date', 'start_time', 'end_time', 'city_code', 'position_id', 'break_minutes', 'notes', 'publish']);
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
    destructive: false,
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
