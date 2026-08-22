(() => {
  'use strict';
  const nativeFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    try {
      const url = typeof input === 'string' ? input : input?.url || '';
      if (url.includes('/functions/v1/call-pipeline-v2') && init?.body) {
        const body = JSON.parse(String(init.body));
        if (body?.action === 'analyze_next' || body?.action === 'finalize') {
          const nextUrl = url.replace('/functions/v1/call-pipeline-v2', '/functions/v1/call-analysis-openrouter-v1');
          return nativeFetch(nextUrl, init);
        }
      }
    } catch (_) {}
    return nativeFetch(input, init);
  };
})();
