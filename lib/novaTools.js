// lib/novaTools.js
// Shared "tool registry" for Nova agentic actions.
// One definition per capability; reused by both Neurolock (routes/ai.js)
// and (later) the external MCP server. No backticks anywhere (Windows-safe).
//
// Each tool's run(actor, args) performs an authenticated internal HTTP call to
// Nova's own /api routes, so existing permission checks and audit logging apply
// unchanged. actor = req.user => { id, email, name, role }.

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

var TOOLS = [
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
    run: async function (actor, args) {
      args = args || {};
      var qs = [];
      if (args.from) qs.push('from=' + encodeURIComponent(args.from));
      if (args.to) qs.push('to=' + encodeURIComponent(args.to));
      if (args.city_code) qs.push('city_code=' + encodeURIComponent(args.city_code));
      var path = '/api/geico/stats' + (qs.length ? ('?' + qs.join('&')) : '');
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
    name: 'list_my_tasks',
    description: 'List the current user open and recent tasks (their own task list). ' +
      'Use to check what the user already has on their plate before creating duplicates.',
    input_schema: { type: 'object', properties: {} },
    write: false,
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
    run: async function (actor, args) {
      args = args || {};
      var body = { title: args.title };
      if (args.description) body.description = args.description;
      if (args.priority) body.priority = args.priority;
      if (args.due_date) body.due_date = args.due_date;
      var data = await apiCall(actor, 'POST', '/api/tasks', body);
      return { id: data.id, title: data.title, due_date: data.due_date, status: data.status };
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
