// Renders the Release of Liability PDF from fixture data so the layout can be
// eyeballed against the Adobe Sign form it replaces. Touches no database.
//
//   node test-release-pdf.js  ->  /tmp/release-sample.pdf
//
// House style: string concatenation only, no template literals.
var fs = require('fs');
var path = require('path');
var rp = require('./utils/releasePdf');

var SIG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAbgAAAB4CAYAAACAVeezAAADz0lEQVR4nO3dS1LjMBiFUUL1Ctj/GtlCetDdVcZtgt/Sf3XOkAF2JKwv8SM8ns/nGwCkeW+9AwBwBYEDIJLAARBJ4ACIJHAARBI4ACIJHACRBA6ASAIHQCSBAyCSwAEQSeAAiCRwAEQSOAAiCRwAkQQOgEgCB0AkgQMgksABEOlX6x2AEXx8fDyXfv75+fm4e19gFI/nc/G4Azb6LmJ7iR8cI3Cw09lBW0P0YD2Bg5XOCNq/QJ35u4BlAgcv7AnR0fC02CYkEjhYsCUyd8Slt/2BCgQO/lobkdYBETtYR+AY3ppg9BqKKlGGFgSOYVUO25K01wNHCRzD+SkECREQOxA4BjJC2OaEjpEJHPFGDNuc0DEigSOWsC0zLoxC4IhjAV/HOJFO4Ihhwd7n1bgZMyoTOCJYpI8zhqQROEqzKJ/PmJJC4CjJInwtp3tJIHCUI273EToqEzjKELZ2jD0VCRwlfLfAWlzvJXRUInB0zYLaJ/NCBQJHlyyg/XN9jt4JHN0Rt1qEjl4JHN0QttrMH70ROLrgJpIcQkcvBI6mLIa5zO2Ylua91XwLHE1Y/Mbg+ly2Nf9n8O1N4BiIuI1H6DKsDdqcwBFP2BC6eqpFbUrguIWbSJgSur5tjVqv8yVwXMqnNl4Run5siVqVeRE4LiFsbCF0bSRGbUrgOJ24sZfQXS89alMCx2mEjbMI3blGitqUwHGYsHGVNQuzv7Flo0ZtSuA4RNy4g9CtI2pfCRy7CBst9P7NGXdLuZ3/KgLHJsJGL0aNnait1yxwTjnU4qI/vUo/Lbfnm0Qqvs4rdB24JSbuXsJGJQmxE7TzlAvclEm9jrBRXYVQHFkHHYM/6/IanE937QgbiVq+oT5j20e2P7IuA7ekwruxyoSNUZwVnKs55o4rE7gpsTuHG33gj9bRc5xdo2Tg5gRvG2GD9ZxirCsicHOeE/nfqM8MAeOKDNzUyJ/uRA0YWXzg5tKDl/AcEMAZhgvcVMIzKE7HAiwbOnBzPT98nhBjgDsJ3Autbx0+QtSA0QncRr1GT9AAvhK4k9wVPiEDWEfgAIj03noHAOAKAgdAJIEDIJLAARBJ4ACIJHAARBI4ACIJHACRBA6ASAIHQCSBAyCSwAEQSeAAiCRwAEQSOAAiCRwAkQQOgEgCB0AkgQMgksABEEngAIgkcABEEjgAIgkcAJEEDoBIAgdAJIEDIJLAARBJ4ACIJHAARBI4ACIJHACRBA6ASAIHQCSBAyCSwAEQSeAAiCRwAEQSOAAiCRwAkQQOgEgCB0AkgQMgksABEEngAIj0G+2UnTUedddCAAAAAElFTkSuQmCC', 'base64');

var release = {
  id: 27,
  release_number: 'ROL-2026-0042',
  status: 'completed',
  claimant_name: 'Marcus Whitfield',
  claimant_phone: '(904) 555-0182',
  claimant_email: 'mwhitfield@example.com',
  claimant_address: '1420 Larkspur Way',
  claimant_city: 'Jacksonville',
  claimant_state: 'FL',
  claimant_zip: '32210',
  vehicle_year: '2024',
  vehicle_make: 'Toyota',
  vehicle_model: 'Highlander',
  vehicle_color: 'Silver',
  license_plate: 'GTX 4471',
  vin: '5TDZA23C13S012345',
  service_date: new Date(2026, 4, 20),
  job_ref: '271884',
  damage_description: 'Body damage to front right passenger side door.',
  settlement_amount: '2845.00',
  release_body: null,
  rep_name: 'Alan Reyes',
  rep_title: 'Southeast Director',
  customer_printed_name: 'Marcus Whitfield',
  customer_signed_at: new Date(2026, 7, 26, 18, 41),
  rep_signed_at: new Date(2026, 7, 27, 9, 12),
  completed_at: new Date(2026, 7, 27, 9, 12)
};

var events = [
  { event_type: 'created', actor: 'Alan Reyes', created_at: new Date(2026, 7, 26, 16, 4) },
  { event_type: 'sent', actor: 'Alan Reyes', created_at: new Date(2026, 7, 26, 16, 12), detail: { to: 'mwhitfield@example.com' } },
  { event_type: 'viewed', actor: 'Marcus Whitfield', ip: '198.51.100.24', user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) Safari/605.1', created_at: new Date(2026, 7, 26, 18, 38) },
  { event_type: 'consented', actor: 'Marcus Whitfield', ip: '198.51.100.24', created_at: new Date(2026, 7, 26, 18, 39) },
  { event_type: 'signed', actor: 'Marcus Whitfield', ip: '198.51.100.24', user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) Safari/605.1', created_at: new Date(2026, 7, 26, 18, 41) },
  { event_type: 'countersigned', actor: 'Alan Reyes', ip: '203.0.113.57', created_at: new Date(2026, 7, 27, 9, 12) },
  { event_type: 'completed', actor: null, created_at: new Date(2026, 7, 27, 9, 12) }
];

rp.buildReleasePdf(release, events, { customerSig: SIG, repSig: SIG })
  .then(function (buf) {
    var out = process.argv[2] || path.join(require('os').tmpdir(), 'release-sample.pdf');
    fs.writeFileSync(out, buf);
    console.log('wrote ' + out + '  (' + buf.length + ' bytes)');
  })
  .catch(function (e) { console.error('CRASH', e); process.exit(1); });
