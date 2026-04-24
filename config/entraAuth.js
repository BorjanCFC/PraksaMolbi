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
    scope: process.env.ENTRA_SCOPE || 'openid profile email'
  };
};

const isEntraConfigured = () => {
  const config = getEntraConfig();
  return !!(config.tenantId && config.clientId && config.clientSecret && config.redirectUri);
};

const getTenantIssuer = (tenantId) => `${MICROSOFT_ISSUER_HOST}/${tenantId}/v2.0`;

const buildAuthorizeUrl = (state, nonce) => {
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

  return `${MICROSOFT_ISSUER_HOST}/${config.tenantId}${MICROSOFT_AUTHORIZE_PATH}?${params.toString()}`;
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
  exchangeCodeForTokens,
  verifyIdToken,
  generateStateToken
};
