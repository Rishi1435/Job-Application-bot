/**
 * Authentication: password hashing, JWT issuing and the Express middleware
 * that turns a bearer token into `req.user`.
 *
 * Passwords are stored as bcrypt hashes only. Tokens carry nothing secret -
 * just the user id and username - and are verified on every protected request,
 * so revoking a user (deleting the row) takes effect as soon as a handler looks
 * the id up.
 *
 * `bcryptjs` is used instead of the native `bcrypt` binding: it is the same
 * algorithm and API surface, but pure JavaScript, so neither the Render build
 * nor the slim Docker image needs python/node-gyp toolchains.
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { createUser, findUserByUsername, findUserById } = require('./database');

const SALT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 10);
const TOKEN_TTL = process.env.JWT_EXPIRES_IN || '7d';
const MIN_PASSWORD_LENGTH = Number(process.env.MIN_PASSWORD_LENGTH || 8);
/**
 * Usernames allow `@` and `+` so an email address can be used as-is - that is
 * what most people type into a "username" box, and rejecting it reads as the
 * sign-up being broken.
 */
const USERNAME_PATTERN = /^[a-zA-Z0-9._+@-]{3,64}$/;

/**
 * The signing secret. Refusing to boot without one is deliberate: a default
 * secret would let anyone mint tokens for any account on a public deployment.
 *
 * @returns {string}
 */
function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('JWT_SECRET must be set to a random string of at least 16 characters.');
  }
  return secret;
}

/** True when a usable secret is configured (checked at startup). */
function isConfigured() {
  try {
    getSecret();
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Credentials                                                         */
/* ------------------------------------------------------------------ */

/**
 * @param {string} password plaintext
 * @returns {Promise<string>} bcrypt hash
 */
function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * @param {string} password plaintext
 * @param {string} hash stored bcrypt hash
 * @returns {Promise<boolean>}
 */
function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * Rejects credentials that could never be stored safely.
 *
 * @param {string} username
 * @param {string} password
 * @returns {string|null} error message, or null when the input is acceptable
 */
function validateCredentials(username, password) {
  if (!username || !password) return 'Username and password are required.';
  if (!USERNAME_PATTERN.test(String(username))) {
    return 'Username must be 3-64 characters - letters, numbers, dot, underscore, hyphen, + or @ (an email address is fine). No spaces.';
  }
  if (String(password).length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {{id:number, username:string}} user
 * @returns {string} signed JWT
 */
function signToken(user) {
  return jwt.sign({ sub: String(user.id), username: user.username }, getSecret(), { expiresIn: TOKEN_TTL });
}

/**
 * @param {string} token
 * @returns {{id:number, username:string}} decoded identity
 * @throws {Error} when the token is missing, expired or forged
 */
function verifyToken(token) {
  const payload = jwt.verify(token, getSecret());
  return { id: Number(payload.sub), username: payload.username };
}

/* ------------------------------------------------------------------ */
/* Registration / login                                                */
/* ------------------------------------------------------------------ */

/**
 * Creates an account and returns a session token.
 *
 * @param {string} username
 * @param {string} password plaintext, hashed before it touches the database
 * @returns {Promise<{token:string, user:{id:number, username:string}}>}
 * @throws {Error} with `.status` set for the route handler to map
 */
async function register(username, password) {
  const problem = validateCredentials(username, password);
  if (problem) throw Object.assign(new Error(problem), { status: 400 });

  if (await findUserByUsername(username)) {
    throw Object.assign(new Error('That username is already taken.'), { status: 409 });
  }

  const user = await createUser(username, await hashPassword(password));
  return { token: signToken(user), user: { id: user.id, username: user.username } };
}

/**
 * Verifies credentials and returns a session token.
 *
 * The same message is returned for an unknown user and a wrong password so the
 * endpoint cannot be used to enumerate accounts.
 *
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{token:string, user:{id:number, username:string}}>}
 */
async function login(username, password) {
  const invalid = Object.assign(new Error('Invalid username or password.'), { status: 401 });
  if (!username || !password) throw Object.assign(new Error('Username and password are required.'), { status: 400 });

  const user = await findUserByUsername(username);
  if (!user) throw invalid;
  if (!(await verifyPassword(password, user.password_hash))) throw invalid;

  return { token: signToken(user), user: { id: user.id, username: user.username } };
}

/* ------------------------------------------------------------------ */
/* Middleware                                                          */
/* ------------------------------------------------------------------ */

/**
 * Express middleware: requires `Authorization: Bearer <jwt>` and attaches
 * `req.user = { id, username }`. The user is re-read from the database so a
 * token for a deleted account stops working immediately.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (!token || scheme.toLowerCase() !== 'bearer') {
    return res.status(401).json({ error: 'Missing bearer token.' });
  }

  try {
    const identity = verifyToken(token);
    const user = await findUserById(identity.id);
    if (!user) return res.status(401).json({ error: 'Account no longer exists.' });

    req.user = { id: user.id, username: user.username };
    return next();
  } catch (error) {
    const expired = error.name === 'TokenExpiredError';
    return res.status(401).json({ error: expired ? 'Session expired - sign in again.' : 'Invalid token.' });
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  validateCredentials,
  signToken,
  verifyToken,
  register,
  login,
  requireAuth,
  isConfigured,
  MIN_PASSWORD_LENGTH,
};
