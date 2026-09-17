const crypto = require('crypto');
const { createRemoteJWKSet, jwtVerify } = require('jose');

const MICROSOFT_ISSUER_HOST = 'https://login.microsoftonline.com';
const MICROSOFT_AUTHORIZE_PATH = '/oauth2/v2.0/authorize';
const MICROSOFT_TOKEN_PATH = '/oauth2/v2.0/token';
const MICROSOFT_JWKS_PATH = '/discovery/v2.0/keys';

const getEntraConfig = () => {
  const tenantId = process.env.ENTRA_TENANT_ID;
  const clientId = process.env.ENTRA_CLIENT_ID;
  const clientSecret = process.env.ENTRA_CLIENT_SECRET;
  const redirectUri = process.env.ENTRA_REDIRECT_URI;

  return {
    tenantId,
    clientId,
    clientSecret,
    redirectUri,
    postLogoutRedirectUri: process.env.ENTRA_POST_LOGOUT_REDIRECT_URI || null,
    scope: process.env.ENTRA_SCOPE || 'openid profile email'
  };
};

const isEntraConfigured = () => {
  const config = getEntraConfig();
  return !!(config.tenantId && config.clientId && config.clientSecret && config.redirectUri);
};

const getTenantIssuer = (tenantId) => `${MICROSOFT_ISSUER_HOST}/${tenantId}/v2.0`;

const buildAuthorizeUrl = (state, nonce, forceInteractiveLogin = true) => {
  const config = getEntraConfig();
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: config.redirectUri,
    response_mode: 'query',
    scope: config.scope,
    state,
    nonce
  });

  // First login and login after the seven-day window request a fresh sign-in.
  // Microsoft Entra policies, not this application, decide whether MFA is required.
  if (forceInteractiveLogin) {
    params.set('prompt', 'login');
  }

  return `${MICROSOFT_ISSUER_HOST}/${config.tenantId}${MICROSOFT_AUTHORIZE_PATH}?${params.toString()}`;
};

const buildLogoutUrl = () => {
  const config = getEntraConfig();
  // The fallback is derived from the configured callback origin, not req.query.
  const postLogoutUri = config.postLogoutRedirectUri ||
    new URL('/login', config.redirectUri).toString();
  const params = new URLSearchParams({
    post_logout_redirect_uri: postLogoutUri
  });
  return `${MICROSOFT_ISSUER_HOST}/${config.tenantId}/oauth2/v2.0/logout?${params.toString()}`;
};

const exchangeCodeForTokens = async (code) => {
  const config = getEntraConfig();

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: config.redirectUri,
    scope: config.scope
  });

  const tokenUrl = `${MICROSOFT_ISSUER_HOST}/${config.tenantId}${MICROSOFT_TOKEN_PATH}`;
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data.error_description || data.error || 'Token endpoint error.';
    throw new Error(message);
  }

  return data;
};

const verifyIdToken = async (idToken, nonce) => {
  const config = getEntraConfig();
  const issuer = getTenantIssuer(config.tenantId);

  const jwks = createRemoteJWKSet(new URL(`${MICROSOFT_ISSUER_HOST}/${config.tenantId}${MICROSOFT_JWKS_PATH}`));

  const { payload } = await jwtVerify(idToken, jwks, {
    issuer,
    audience: config.clientId,
    nonce
  });

  return payload;
};

const generateStateToken = () => crypto.randomBytes(24).toString('hex');

module.exports = {
  getEntraConfig,
  isEntraConfigured,
  buildAuthorizeUrl,
  buildLogoutUrl,
  exchangeCodeForTokens,
  verifyIdToken,
  generateStateToken
};
