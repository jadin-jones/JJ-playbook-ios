/* The admin addresses, one list for every Netlify function and script.
 * The same three are in firestore.rules (isAdmin) and in the app
 * (ADMIN_EMAILS in public/index.html); change all three together.
 * A Microsoft sign-in is never an admin, whatever its address.
 */
const ADMINS = ['charlie@jadin-jones.com', 'lucas@jadin-jones.com', 'review@jadin-jones.com'];
module.exports = { ADMINS };
