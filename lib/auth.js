'use strict';
const crypto = require('crypto');

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30일

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

// 공용 비밀번호 1개로 로그인 → 서명된 토큰 발급. 비밀번호 자체는 브라우저에 저장하지 않는다.
// SESSION_SECRET이 없으면 비밀번호에서 서명 키를 만든다 (비밀번호를 바꾸면 기존 토큰이 모두 무효가 된다).
function createAuth({ password, secret, now = () => Date.now() }) {
  if (!password) throw new Error('APP_PASSWORD가 설정되지 않았습니다.');
  const key = secret || crypto.createHash('sha256').update('card-ledger|' + password).digest('hex');
  const sign = payload => crypto.createHmac('sha256', key).update(payload).digest('base64url');

  return {
    checkPassword: p => typeof p === 'string' && safeEqual(p, password),
    issueToken() {
      const exp = String(now() + TOKEN_TTL_MS);
      return `${exp}.${sign(exp)}`;
    },
    verifyToken(token) {
      if (typeof token !== 'string') return false;
      const i = token.indexOf('.');
      if (i < 1) return false;
      const exp = token.slice(0, i), sig = token.slice(i + 1);
      const good = sign(exp);
      if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
      return Number(exp) > now();
    }
  };
}

// 비밀번호 무차별 대입 방지: IP당 10분에 실패 10회까지.
function createLoginLimiter({ max = 10, windowMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
  const hits = new Map();
  return {
    blocked(ip) {
      const h = hits.get(ip);
      if (!h) return false;
      if (h.resetAt <= now()) { hits.delete(ip); return false; }
      return h.count >= max;
    },
    fail(ip) {
      const h = hits.get(ip);
      if (!h || h.resetAt <= now()) hits.set(ip, { count: 1, resetAt: now() + windowMs });
      else h.count++;
    },
    success(ip) { hits.delete(ip); }
  };
}

module.exports = { createAuth, createLoginLimiter };
