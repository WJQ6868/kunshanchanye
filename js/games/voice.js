/* ============================================================
   语音输入（Web Speech API）
   ============================================================ */
(function () {
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const supported = typeof Rec === 'function';
  const secure = window.isSecureContext || ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  const MIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6"/></svg>';

  let active = null;

  function notify(text) {
    if (typeof window.toast === 'function') window.toast(text);
  }

  function stopVoice() {
    if (active) {
      const rec = active.rec;
      active = null;
      try { rec.stop(); } catch (e) { /* 忽略 */ }
    }
    document.querySelectorAll('.voice-btn.listening').forEach(btn => {
      btn.classList.remove('listening');
      btn.removeAttribute('aria-pressed');
    });
  }

  function startVoice(input, btn) {
    if (active && active.input === input) { stopVoice(); return; }
    stopVoice();

    if (!supported) {
      notify('当前浏览器不支持语音输入，建议使用 Chrome 或 Edge');
      return;
    }
    if (!secure) {
      notify('语音输入需要 HTTPS 访问，请用 https:// 打开页面');
      return;
    }

    const rec = new Rec();
    rec.lang = input.dataset.voiceLang || 'zh-CN';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.continuous = false;

    const base = input.value;
    const separator = rec.lang.toLowerCase().startsWith('en') && base && !/\s$/.test(base) ? ' ' : '';
    let finalText = '';

    rec.onstart = () => {
      active = { rec, input };
      btn.classList.add('listening');
      btn.setAttribute('aria-pressed', 'true');
    };

    rec.onresult = event => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      let next = base + separator + finalText + interim;
      if (input.maxLength > 0 && next.length > input.maxLength) next = next.slice(0, input.maxLength);
      input.value = next;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };

    rec.onerror = event => {
      const messages = {
        'not-allowed': '麦克风权限被拒绝，请在浏览器地址栏允许麦克风',
        'service-not-allowed': '语音服务不可用，请确认页面使用 HTTPS',
        'audio-capture': '没有检测到麦克风',
        'no-speech': '没有听到声音，请再点一次',
        network: '语音识别服务网络异常'
      };
      if (event.error !== 'aborted') notify(messages[event.error] || '语音输入失败，请重试');
    };

    rec.onend = () => {
      btn.classList.remove('listening');
      btn.removeAttribute('aria-pressed');
      if (active && active.rec === rec) active = null;
      if (finalText) input.focus({ preventScroll: true });
    };

    try {
      rec.start();
    } catch (err) {
      notify('语音输入启动失败，请稍后重试');
      btn.classList.remove('listening');
    }
  }

  function enhance(root = document) {
    if (!supported) return;
    Array.from(root.querySelectorAll('input.ipt')).forEach(input => {
      if (input.dataset.voiceReady) return;
      if (input.type === 'number' || input.type === 'hidden') return;
      if (input.closest('.voice-wrap')) { input.dataset.voiceReady = '1'; return; }

      input.dataset.voiceReady = '1';
      const wrap = document.createElement('span');
      wrap.className = 'voice-wrap';
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'voice-btn';
      btn.setAttribute('aria-label', '语音输入');
      btn.setAttribute('title', secure ? '语音输入' : '语音输入（需要 HTTPS）');
      btn.innerHTML = MIC;
      btn.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        startVoice(input, btn);
      });
      wrap.appendChild(btn);
    });
  }

  window.enhanceVoiceInputs = enhance;
  window.stopVoiceInput = stopVoice;
  window.voiceInputSupported = supported;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => enhance(document));
  } else {
    enhance(document);
  }
})();
