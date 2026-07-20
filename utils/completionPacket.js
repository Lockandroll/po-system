// Offboarding Completion Packet Generator
// Creates HTML summary of the offboarding process

const { pool } = require('../db');

/**
 * Generate an HTML completion packet for an offboarding
 * Includes: employee info, offboarding timeline, steps completed, exit interview responses
 */
async function generateCompletionPacket(offboardingId) {
  const client = await pool.connect();
  try {
    // Fetch offboarding details
    const obRes = await client.query(
      `SELECT o.*, u.name, u.email, u.role, u.created_at as hire_date
       FROM offboardings o
       JOIN users u ON o.user_id = u.id
       WHERE o.id = $1`,
      [offboardingId]
    );

    if (!obRes.rows.length) {
      throw new Error('Offboarding not found');
    }

    const ob = obRes.rows[0];
    const hireDate = new Date(ob.hire_date);
    const lastDay = new Date(ob.last_day);
    const tenureDays = Math.floor((lastDay - hireDate) / (1000 * 60 * 60 * 24));
    const tenureYears = (tenureDays / 365).toFixed(1);

    // Fetch completed steps
    const stepsRes = await client.query(
      `SELECT title, category, status, completed_at, skip_reason
       FROM offboarding_steps
       WHERE offboarding_id = $1
       ORDER BY position`,
      [offboardingId]
    );

    // Fetch exit interview
    const interviewRes = await client.query(
      `SELECT ei.*, json_agg(json_build_object(
        'question', ia.question_snapshot->>'prompt',
        'value', COALESCE(ia.value_text, ia.value_num::text)
       )) as responses
       FROM exit_interviews ei
       LEFT JOIN exit_interview_answers ia ON ei.id = ia.interview_id
       WHERE ei.offboarding_id = $1
       GROUP BY ei.id`,
      [offboardingId]
    );

    const interview = interviewRes.rows[0];

    // Count steps by status
    const stepsCount = {
      done: stepsRes.rows.filter(s => s.status === 'done').length,
      skipped: stepsRes.rows.filter(s => s.status === 'skipped').length,
      pending: stepsRes.rows.filter(s => s.status === 'pending').length,
      total: stepsRes.rows.length
    };

    // Generate HTML
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; margin: 40px; color: #333; }
    h1 { color: #2c3e50; border-bottom: 3px solid #3498db; padding-bottom: 10px; }
    h2 { color: #34495e; margin-top: 30px; }
    .header-box { background: #ecf0f1; padding: 20px; border-radius: 5px; margin-bottom: 20px; }
    .header-box p { margin: 8px 0; }
    .stat { display: inline-block; background: #3498db; color: white; padding: 10px 20px; margin: 5px; border-radius: 3px; }
    table { width: 100%; border-collapse: collapse; margin: 15px 0; }
    th { background: #3498db; color: white; padding: 12px; text-align: left; }
    td { padding: 10px; border-bottom: 1px solid #ddd; }
    tr:hover { background: #f5f5f5; }
    .status-done { color: green; font-weight: bold; }
    .status-skipped { color: orange; }
    .status-pending { color: red; }
    .interview-section { background: #f9f9f9; padding: 15px; border-left: 4px solid #27ae60; }
    .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #bdc3c7; color: #7f8c8d; font-size: 12px; }
  </style>
</head>
<body>
  <h1>Offboarding Completion Packet</h1>
  <p><strong>Generated:</strong> ${new Date().toLocaleString()}</p>

  <div class="header-box">
    <h2>Employee Information</h2>
    <p><strong>Name:</strong> ${ob.name}</p>
    <p><strong>Email:</strong> ${ob.email}</p>
    <p><strong>Role:</strong> ${ob.role}</p>
    <p><strong>Hire Date:</strong> ${hireDate.toLocaleDateString()}</p>
    <p><strong>Last Day:</strong> ${lastDay.toLocaleDateString()}</p>
    <p><strong>Tenure:</strong> ${tenureYears} years (${tenureDays} days)</p>
    <p><strong>Type of Departure:</strong> ${ob.type.replace('_', ' ')}</p>
    <p><strong>Eligible for Rehire:</strong> ${ob.eligible_for_rehire ? 'Yes' : 'No'}</p>
  </div>

  <h2>Offboarding Progress</h2>
  <div>
    <span class="stat">✓ Completed: ${stepsCount.done}</span>
    <span class="stat" style="background: #f39c12;">⊘ Skipped: ${stepsCount.skipped}</span>
    <span class="stat" style="background: #e74c3c;">○ Pending: ${stepsCount.pending}</span>
    <span class="stat" style="background: #95a5a6;">Total: ${stepsCount.total}</span>
  </div>

  <h2>Offboarding Checklist</h2>
  <table>
    <thead>
      <tr>
        <th>Step</th>
        <th>Category</th>
        <th>Status</th>
        <th>Completed</th>
      </tr>
    </thead>
    <tbody>
      ${stepsRes.rows.map(s => `
        <tr>
          <td>${s.title}</td>
          <td>${s.category}</td>
          <td class="status-${s.status}">${s.status.charAt(0).toUpperCase() + s.status.slice(1)}</td>
          <td>${s.completed_at ? new Date(s.completed_at).toLocaleDateString() : s.skip_reason || '—'}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>

  ${interview && interview.status !== 'draft' ? `
  <div class="interview-section">
    <h2>Exit Interview Summary</h2>
    <p><strong>Status:</strong> ${interview.status}</p>
    <p><strong>Would Return:</strong> ${interview.would_return || 'Not provided'}</p>
    ${interview.responses && interview.responses[0] ? `
    <h3>Responses</h3>
    <ul>
      ${interview.responses.filter(r => r.question).map(r => `
        <li><strong>${r.question}:</strong> ${r.value || 'No response'}</li>
      `).join('')}
    </ul>
    ` : ''}
  </div>
  ` : ''}

  <div class="footer">
    <p>This is an official record of the offboarding process for ${ob.name}.</p>
    <p>Offboarding ID: ${offboardingId}</p>
  </div>
</body>
</html>`;

    return html;
  } finally {
    client.release();
  }
}

module.exports = {
  generateCompletionPacket
};
