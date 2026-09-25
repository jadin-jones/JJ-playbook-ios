/* Builds an invite email from the wording in invite-products.js.
 *
 *   render(product, programId, { email, link, code, site, expiresAt })
 *     -> { from, subject, text, html }
 *
 * Plain text and HTML carry the same words. The HTML is a single centered
 * card in the app's colours (navy button, yellow text), built from tables
 * with inline styles so Gmail, Outlook and phone mail apps show it alike.
 * Every inserted value is HTML-escaped.
 */
const PRODUCTS = require('./invite-products');

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function fmtDate(ms) {
  try {
    return new Date(ms).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' });
  } catch (e) { return new Date(ms).toDateString(); }
}

function render(productKey, programId, d) {
  const p = PRODUCTS[productKey];
  if (!p || !p.programs[programId]) throw new Error('Unknown product or program');
  const e = p.email;
  const vals = { product: p.name, lessonCount: String(p.programs[programId].lessonCount), email: d.email,
    date: fmtDate(d.expiresAt), site: String(d.site || '').replace(/^https?:\/\//, ''), CODE: d.code };
  const fill = t => String(t).replace(/\{(product|lessonCount|email|date|site|CODE)\}/g, (m, k) => vals[k]);
  // HTML: the same text, with the code, email and date picked out.
  const fillHtml = t => esc(t).replace(/\{(product|lessonCount|email|date|site|CODE)\}/g, (m, k) =>
    (k === 'CODE' || k === 'date' || k === 'email') ? '<strong>' + esc(vals[k]) + '</strong>' : esc(vals[k]));

  const subject = fill(e.subject);
  const text = [fill(e.lead), '']
    .concat(e.body.map(fill), [''], [e.button + ': ' + d.link, ''], e.afterButton.map(fill).reduce((a, l) => a.concat([l, '']), []),
      e.signoff.map(fill)).join('\n');

  const P = 'margin:0 0 14px;font-size:15px;line-height:1.6;color:#37475C';
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + esc(subject) + '</title></head>'
    + '<body style="margin:0;padding:0;background:#F3F7FB;font-family:Montserrat,Helvetica,Arial,sans-serif">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F7FB"><tr><td align="center" style="padding:24px 12px">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid #DCE6F0;border-radius:14px">'
    + '<tr><td style="background:#0C2647;border-radius:14px 14px 0 0;padding:18px 24px">'
    + '<div style="font-weight:800;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#FADA01">' + esc(p.name) + '</div></td></tr>'
    + '<tr><td style="padding:24px 24px 8px">'
    + '<p style="margin:0 0 14px;font-weight:800;font-size:19px;line-height:1.35;color:#0C1B2E">' + fillHtml(e.lead) + '</p>'
    + e.body.map(l => '<p style="' + P + '">' + fillHtml(l) + '</p>').join('')
    + '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 22px"><tr><td style="background:#0C2647;border-radius:10px">'
    + '<a href="' + esc(d.link) + '" style="display:inline-block;padding:14px 28px;font-weight:800;font-size:14px;letter-spacing:.08em;text-transform:uppercase;color:#FADA01;text-decoration:none">' + esc(e.button) + '</a>'
    + '</td></tr></table>'
    + e.afterButton.map(l => '<p style="' + P + ';font-size:14px">' + fillHtml(l) + '</p>').join('')
    + '</td></tr>'
    + '<tr><td style="padding:4px 24px 22px;border-top:1px solid #EEF3F8">'
    + '<p style="margin:14px 0 0;font-size:14px;line-height:1.5;color:#0C1B2E">' + e.signoff.map(l => esc(fill(l))).join('<br>') + '</p>'
    + '</td></tr></table></td></tr></table></body></html>';

  return { from: '"' + p.fromName + '" <' + p.fromEmail + '>', subject, text, html };
}

module.exports = { render, fmtDate, PRODUCTS };
