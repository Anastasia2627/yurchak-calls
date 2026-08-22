(() => {
  'use strict';
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    try {
      const url = typeof input === 'string' ? input : input?.url;
      if (typeof url === 'string' && url.includes('/functions/v1/call-pipeline-v2') && String(init?.method || 'GET').toUpperCase() === 'POST' && typeof init?.body === 'string') {
        const body = JSON.parse(init.body);
        if (body?.action === 'analyze_next' || body?.action === 'finalize') {
          const routedUrl = url.replace('/functions/v1/call-pipeline-v2', '/functions/v1/call-analysis-openrouter-v1');
          return nativeFetch(routedUrl, init);
        }
      }
    } catch (error) {
      console.warn('AI provider routing fallback', error);
    }
    return nativeFetch(input, init);
  };
})();
