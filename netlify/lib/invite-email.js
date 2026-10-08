/* Builds an invite email from the wording in invite-products.js.
 *
 *   render(product, programId, { email, link, code, site, expiresAt })
 *     -> { from, subject, text, html }
 *
 * Plain text and HTML carry the same words. The HTML follows the
 * jadin-jones.com brand: navy header and footer (#033266, the logo's and the
 * site's navy), lime accents (#D9E244, the site's), logo blue for links
 * (#1A9FDA). It is email-safe: tables, inline styles, a bgcolor on every
 * coloured cell (Outlook), Montserrat with an Arial fallback, a 600px card
 * that narrows on phones, and a dark-mode style for clients that honour it.
 * The logo is the site's own /assets/jj-lockup.png (navy background), so
 * Dev mail loads Dev's copy and live mail live's; its alt text is styled to
 * read JADIN | JONES in white if images are blocked. In "Jadin | Jones" the
 * bar is drawn thin and in an accent colour, since in a bold sans-serif a
 * plain | reads as a capital I. Every inserted value is HTML-escaped.
 */
const PRODUCTS = require('./invite-products');

const NAVY = '#033266', LIME = '#D9E244', BLUE = '#1A9FDA', INK = '#1D2B3A', PAGE = '#EEF2F7';
const FONT = "Montserrat,Arial,Helvetica,sans-serif";

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/* "Jadin | Jones" (already escaped) with the bar thin, spaced and coloured. */
const brand = (html, color) => html.replace(/Jadin \| Jones/gi, m =>
  m.slice(0, 5) + '<span style="font-weight:300;color:' + color + ';padding:0 0.2em">|</span>' + m.slice(-5));

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
  const siteUrl = /^https?:\/\//.test(String(d.site || '')) ? String(d.site).replace(/\/+$/, '') : 'https://' + vals.site;
  // HTML: the same text, with the code, email and date picked out and the site a link.
  const fillHtml = t => brand(esc(t).replace(/\{(product|lessonCount|email|date|site|CODE)\}/g, (m, k) =>
    k === 'site' ? '<a href="' + esc(siteUrl) + '" style="color:' + BLUE + ';text-decoration:underline">' + esc(vals.site) + '</a>'
    : (k === 'CODE' || k === 'date' || k === 'email') ? '<strong>' + esc(vals[k]) + '</strong>' : esc(vals[k])), BLUE);
  // The headline: uppercase, the product's name in lime.
  const head = brand(esc(e.lead).replace(/\{(product|lessonCount|email|date|site|CODE)\}/g, (m, k) =>
    k === 'product' ? '<span style="color:' + LIME + '">' + esc(vals.product) + '</span>' : esc(vals[k])), LIME);

  const subject = fill(e.subject);
  const text = [fill(e.lead), '']
    .concat(e.body.map(fill), [''], [e.button + ': ' + d.link, ''], e.afterButton.map(fill).reduce((a, l) => a.concat([l, '']), []),
      e.signoff.map(fill)).join('\n');

  const P = 'margin:0 0 16px;font-family:' + FONT + ';font-size:15px;line-height:1.6;color:' + INK;
  const signoff = e.signoff.map(fill);
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">'
    + '<title>' + esc(subject) + '</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;700;800&display=swap" rel="stylesheet">'
    + '<!--[if mso]><style>*{font-family:Arial,Helvetica,sans-serif!important}</style><![endif]-->'
    + '<style>'
    + '@media (max-width:480px){.jj-pad{padding-left:22px!important;padding-right:22px!important}.jj-h1{font-size:21px!important}}'
    + '@media (prefers-color-scheme:dark){.jj-page{background:#0B1830!important}.jj-card{background:#10223F!important}.jj-text,.jj-text strong{color:#E6EDF5!important}}'
    + '[data-ogsc] .jj-card{background:#10223F!important}[data-ogsc] .jj-text,[data-ogsc] .jj-text strong{color:#E6EDF5!important}'
    + '</style></head>'
    + '<body class="jj-page" style="margin:0;padding:0;background:' + PAGE + '">'
    // Inbox preview line.
    + '<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">' + esc(fill(e.lead)) + '</div>'
    + '<table role="presentation" class="jj-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + PAGE + '" style="background:' + PAGE + '">'
    + '<tr><td align="center" style="padding:24px 12px">'
    + '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">'
    // Header: logo, product name in lime.
    + '<tr><td align="center" bgcolor="' + NAVY + '" style="background:' + NAVY + ';padding:30px 24px 6px">'
    + '<img src="' + esc(siteUrl) + '/assets/jj-lockup.png" width="220" alt="JADIN | JONES" style="display:block;width:220px;max-width:100%;height:auto;border:0;outline:none;margin:0 auto;'
    + 'font-family:' + FONT + ';font-size:16px;font-weight:800;letter-spacing:0.22em;color:#FFFFFF;text-align:center">'
    + '<div style="font-family:' + FONT + ';font-size:11px;font-weight:700;letter-spacing:0.24em;text-transform:uppercase;color:' + LIME + ';padding-top:12px">' + esc(p.name) + '</div>'
    + '</td></tr>'
    // Headline, on navy so the lime reads.
    + '<tr><td align="center" class="jj-pad" bgcolor="' + NAVY + '" style="background:' + NAVY + ';padding:18px 40px 34px">'
    + '<h1 class="jj-h1" style="margin:0;font-family:' + FONT + ';font-size:24px;line-height:1.3;font-weight:800;letter-spacing:0.02em;text-transform:uppercase;color:#FFFFFF">' + head + '</h1>'
    + '</td></tr>'
    // Body.
    + '<tr><td class="jj-card jj-pad" bgcolor="#FFFFFF" style="background:#FFFFFF;padding:32px 40px 12px">'
    + e.body.map(l => '<p class="jj-text" style="' + P + '">' + fillHtml(l) + '</p>').join('')
    // Button: square, lime, navy text.
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0 28px"><tr>'
    + '<td bgcolor="' + LIME + '" style="background:' + LIME + ';border-radius:0">'
    + '<a href="' + esc(d.link) + '" style="display:inline-block;padding:16px 36px;border:1px solid ' + LIME + ';border-radius:0;font-family:' + FONT + ';font-size:14px;font-weight:800;letter-spacing:0.16em;text-transform:uppercase;color:' + NAVY + ';text-decoration:none">'
    + esc(e.button.toUpperCase()) + '</a></td></tr></table>'
    + e.afterButton.map(l => '<p class="jj-text" style="' + P + ';font-size:14px">' + fillHtml(l) + '</p>').join('')
    + '</td></tr>'
    // Footer.
    + '<tr><td align="center" bgcolor="' + NAVY + '" style="background:' + NAVY + ';padding:24px 24px 26px">'
    + '<p style="margin:0;font-family:' + FONT + ';font-size:14px;font-weight:700;color:#FFFFFF">' + brand(esc(signoff[0] || ''), LIME) + '</p>'
    + (signoff[1] ? '<p style="margin:6px 0 0;font-family:' + FONT + ';font-size:13px"><a href="https://' + esc(signoff[1].replace(/^https?:\/\//, '')) + '" style="color:#FFFFFF;text-decoration:underline">' + esc(signoff[1]) + '</a></p>' : '')
    + '</td></tr>'
    + '</table></td></tr></table></body></html>';

  return { from: '"' + p.fromName + '" <' + p.fromEmail + '>', subject, text, html };
}

module.exports = { render, fmtDate, PRODUCTS };
