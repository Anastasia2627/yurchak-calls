(() => {
  'use strict';
  const nativeFetch = window.fetch.bind(window);

  function headersObject(headers) {
    try { return new Headers(headers || {}); } catch { return new Headers(); }
  }

  async function completedCallAt(url, init) {
    try {
      const headers = headersObject(init?.headers);
      const response = await nativeFetch(url, { method: 'GET', headers });
      if (!response.ok) return null;
      const data = await response.json();
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.status === 'ready' && (Array.isArray(row.summary) || Array.isArray(row.topics))) return row;
    } catch (error) {
      console.warn('Completed call guard check failed', error);
    }
    return null;
  }

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url;
    const method = String(init?.method || 'GET').toUpperCase();

    try {
      if (typeof url === 'string' && url.includes('/rest/v1/calls_v2') && method === 'PATCH' && typeof init?.body === 'string') {
        const patch = JSON.parse(init.body);
        if (['uploading', 'transcribing', 'analyzing', 'error'].includes(String(patch?.status || ''))) {
          const current = await completedCallAt(url, init);
          if (current) {
            const accept = headersObject(init?.headers).get('accept') || '';
            const body = accept.includes('application/vnd.pgrst.object+json') ? current : [current];
            setTimeout(() => location.reload(), 80);
            return new Response(JSON.stringify(body), {
              status: 200,
              headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
          }
        }
      }

      if (typeof url === 'string' && url.includes('/functions/v1/call-pipeline-v2') && method === 'POST' && typeof init?.body === 'string') {
        const body = JSON.parse(init.body);
        if (body?.action === 'analyze_next' || body?.action === 'finalize') {
          const routedUrl = url.replace('/functions/v1/call-pipeline-v2', '/functions/v1/call-analysis-openrouter-v1');
          return nativeFetch(routedUrl, init);
        }
      }
    } catch (error) {
      console.warn('Request routing fallback', error);
    }

    return nativeFetch(input, init);
  };
})();
