/* ============================================================
   crypto.js —— 密码哈希与随机串
   ------------------------------------------------------------
   本地模式没有服务端，密码只能在本机校验。这里用 PBKDF2-SHA256
   派生，绝不明文保存、也不用裸 SHA256。

   两条路径：
     1) crypto.subtle 可用（https / localhost / file:）→ 原生 PBKDF2，快
     2) 不可用（局域网 http 访问，非安全上下文）→ 内置纯 JS SHA-256 迭代
   两条路径结果格式一致，都存 base64。

   注意：本机校验只防「误操作与顺手翻看」，不防有本机文件访问权限的人。
   真正的账号安全在 P1 服务端版（argon2id + HttpOnly 会话）。
   ============================================================ */
(function (global) {
  'use strict';

  var RCIter = 120000;          // 迭代次数（原生路径）
  var RCIterFallback = 20000;   // 纯 JS 路径慢，降迭代数保证 200ms 内返回

  /* ---------- base64 ---------- */

  function bytesToB64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return global.btoa(s);
  }

  function b64ToBytes(b64) {
    var s = global.atob(b64);
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function utf8(str) {
    if (global.TextEncoder) return new global.TextEncoder().encode(str);
    var esc = unescape(encodeURIComponent(str));
    var out = new Uint8Array(esc.length);
    for (var i = 0; i < esc.length; i++) out[i] = esc.charCodeAt(i);
    return out;
  }

  /* ---------- 纯 JS SHA-256（非安全上下文兜底） ---------- */

  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function sha256(bytes) {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var len = bytes.length;
    var bitLen = len * 8;
    var withPad = new Uint8Array(((len + 9 + 63) >> 6) << 6);
    withPad.set(bytes);
    withPad[len] = 0x80;
    // 长度写到末尾 8 字节（大端），高位永远为 0（消息 < 2^32 位）
    withPad[withPad.length - 4] = (bitLen >>> 24) & 0xff;
    withPad[withPad.length - 3] = (bitLen >>> 16) & 0xff;
    withPad[withPad.length - 2] = (bitLen >>> 8) & 0xff;
    withPad[withPad.length - 1] = bitLen & 0xff;

    var W = new Array(64);
    for (var off = 0; off < withPad.length; off += 64) {
      for (var i = 0; i < 16; i++) {
        W[i] = (withPad[off + i * 4] << 24) | (withPad[off + i * 4 + 1] << 16) |
               (withPad[off + i * 4 + 2] << 8) | withPad[off + i * 4 + 3];
      }
      for (var i2 = 16; i2 < 64; i2++) {
        var s0 = rotr(W[i2 - 15], 7) ^ rotr(W[i2 - 15], 18) ^ (W[i2 - 15] >>> 3);
        var s1 = rotr(W[i2 - 2], 17) ^ rotr(W[i2 - 2], 19) ^ (W[i2 - 2] >>> 10);
        W[i2] = (W[i2 - 16] + s0 + W[i2 - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (var t = 0; t < 64; t++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[t] + W[t]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }

    var out = new Uint8Array(32);
    for (var j = 0; j < 8; j++) {
      out[j * 4] = (H[j] >>> 24) & 0xff;
      out[j * 4 + 1] = (H[j] >>> 16) & 0xff;
      out[j * 4 + 2] = (H[j] >>> 8) & 0xff;
      out[j * 4 + 3] = H[j] & 0xff;
    }
    return out;
  }

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  function concat(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  /** 纯 JS 的 PBKDF2-HMAC-SHA256（只做 1 块输出，32 字节够用） */
  function pbkdf2Fallback(password, salt, iterations) {
    var pw = utf8(password);
    var block = concat(salt, new Uint8Array([0, 0, 0, 1]));

    // HMAC-SHA256(key=pw, msg=block)
    function hmac(msg) {
      var key = pw.length > 64 ? sha256(pw) : pw;
      var ipad = new Uint8Array(64);
      var opad = new Uint8Array(64);
      for (var i = 0; i < 64; i++) {
        var k = i < key.length ? key[i] : 0;
        ipad[i] = k ^ 0x36;
        opad[i] = k ^ 0x5c;
      }
      return sha256(concat(opad, sha256(concat(ipad, msg))));
    }

    var u = hmac(block);
    var acc = new Uint8Array(u);
    for (var n = 1; n < iterations; n++) {
      u = hmac(u);
      for (var i2 = 0; i2 < acc.length; i2++) acc[i2] ^= u[i2];
    }
    return acc;
  }

  /* ---------- 对外：派生密码哈希 ---------- */

  function hasSubtle() {
    return !!(global.crypto && global.crypto.subtle && global.isSecureContext);
  }

  /**
   * 派生密码哈希。
   * @returns {Promise<{algo:string, iter:number, salt:string, hash:string}>}
   */
  function derive(password, saltB64) {
    var salt = saltB64 ? b64ToBytes(saltB64) : randomBytes(16);
    var saltOut = saltB64 || bytesToB64(salt);

    if (hasSubtle()) {
      var enc = new global.TextEncoder();
      return global.crypto.subtle
        .importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
        .then(function (key) {
          return global.crypto.subtle.deriveBits(
            { name: 'PBKDF2', salt: salt, iterations: RCIter, hash: 'SHA-256' }, key, 256
          );
        })
        .then(function (bits) {
          return { algo: 'pbkdf2-sha256', iter: RCIter, salt: saltOut, hash: bytesToB64(new Uint8Array(bits)) };
        })
        .catch(function () {
          var fb = pbkdf2Fallback(password, salt, RCIterFallback);
          return { algo: 'pbkdf2-sha256-js', iter: RCIterFallback, salt: saltOut, hash: bytesToB64(fb) };
        });
    }

    return Promise.resolve().then(function () {
      var fb = pbkdf2Fallback(password, salt, RCIterFallback);
      return { algo: 'pbkdf2-sha256-js', iter: RCIterFallback, salt: saltOut, hash: bytesToB64(fb) };
    });
  }

  /** 校验密码（用记录里的 salt 与 iter 重算，保证旧哈希仍可验证） */
  function verify(password, rec) {
    if (!rec || !rec.hash) return Promise.resolve(false);
    var salt = b64ToBytes(rec.salt);
    var iter = rec.iter || RCIter;
    var algo = rec.algo || 'pbkdf2-sha256';

    if (algo === 'pbkdf2-sha256' && hasSubtle()) {
      var enc = new global.TextEncoder();
      return global.crypto.subtle
        .importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
        .then(function (key) {
          return global.crypto.subtle.deriveBits(
            { name: 'PBKDF2', salt: salt, iterations: iter, hash: 'SHA-256' }, key, 256
          );
        })
        .then(function (bits) {
          return bytesToB64(new Uint8Array(bits)) === rec.hash;
        })
        .catch(function () { return false; });
    }

    return Promise.resolve().then(function () {
      return bytesToB64(pbkdf2Fallback(password, salt, iter)) === rec.hash;
    });
  }

  /* ---------- 随机串 ---------- */

  function randomBytes(n) {
    var out = new Uint8Array(n);
    if (global.crypto && global.crypto.getRandomValues) {
      global.crypto.getRandomValues(out);
    } else {
      for (var i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
    }
    return out;
  }

  function randomId(prefix) {
    if (global.crypto && global.crypto.randomUUID) return (prefix || '') + global.crypto.randomUUID();
    var b = randomBytes(16);
    var hex = '';
    for (var i = 0; i < b.length; i++) hex += ('0' + b[i].toString(16)).slice(-2);
    return (prefix || '') + hex;
  }

  /** 密码强度：返回 {ok, score, msg}，不满足最低要求时 ok=false */
  function checkPassword(pw) {
    var s = String(pw || '');
    if (s.length < 6) return { ok: false, score: 0, msg: '密码至少 6 位' };
    var kinds = 0;
    if (/[a-z]/.test(s)) kinds++;
    if (/[A-Z]/.test(s)) kinds++;
    if (/[0-9]/.test(s)) kinds++;
    if (/[^A-Za-z0-9]/.test(s)) kinds++;
    var score = Math.min(4, kinds + (s.length >= 10 ? 1 : 0));
    return { ok: true, score: score, msg: score >= 3 ? '强度足够' : '建议再加数字或符号' };
  }

  global.RCCrypto = {
    derive: derive,
    verify: verify,
    randomId: randomId,
    randomBytes: randomBytes,
    checkPassword: checkPassword,
    usingNative: hasSubtle
  };
})(window);
