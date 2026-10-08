/* Invite settings, one entry per product. Edit the wording here: nothing
 * else needs to change.
 *
 * Placeholders in the email text, filled in for each person:
 *   {product}      the product's name
 *   {lessonCount}  36 or 10, from the version picked
 *   {email}        the address the invite is for
 *   {date}         when the link expires, e.g. "Thursday, 2 October 2026"
 *   {site}         the site's own address, e.g. jj-twinthieves-preview.netlify.app
 *   {CODE}         that version's current join code
 * The Join now button goes where the invite link points; it is not in the
 * text. Each line of `body` is its own paragraph ('' leaves a gap); `lead`
 * is the bold first line and `signoff` the closing lines.
 *
 * Only Twin Thieves is set up. The Playbook can be added later as another
 * entry; nothing of the Playbook's reads this file today.
 */
module.exports = {
  tt: {
    name: 'Twin Thieves Leadership',
    fromName: 'Jadin | Jones Team',
    fromEmail: 'charlie@jadin-jones.com',
    linkDays: 7,
    programs: {
      TT36: { label: 'Twin Thieves Leadership (36 lessons)', lessonCount: 36 },
      TT10: { label: 'Twin Thieves Leadership (10 lessons)', lessonCount: 10 }
    },
    email: {
      subject: "You're invited to {product}",
      lead: "You've been invited by the Jadin | Jones Team to join {product}.",
      body: [
        'Welcome! {product} is a series of {lessonCount} short video lessons on the fundamentals of great leadership. Watch at your own pace, work through the questions, and track your progress as you go.'
      ],
      button: 'Join now',
      afterButton: [
        'This link is just for you. Sign in with {email}. It works once and expires on {date}.',
        'Button not working? Go to {site} and enter the join code {CODE}.',
        'Questions? Just reply to this email.',
        "If you weren't expecting this invitation, you can ignore it."
      ],
      signoff: ['The Jadin | Jones Team', 'jadin-jones.com']
    }
  }
};
