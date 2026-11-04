// 浏览器端 RAG 服务：fetch 加载 corpus.json，失败降级不抛错，可在 Node 注入 fetchImpl。
// 不引用 document / window。

import { createKnowledgeIndex } from './index.mjs';
import { composeAnswer } from './answer.mjs';

const now = () => {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  if (typeof Date !== 'undefined' && typeof Date.now === 'function') return Date.now();
  return 0;
};

/**
 * @param {{ corpusUrl?: string, fetchImpl?: typeof fetch, indexOptions?: object }} [options]
 */
export function createRagService(options = {}) {
  const corpusUrl = typeof options.corpusUrl === 'string' && options.corpusUrl
    ? options.corpusUrl
    : '/knowledge/corpus.json';
  const fetchImpl = options.fetchImpl
    || (typeof fetch === 'function' ? fetch : null);
  const indexOptions = options.indexOptions || {};

  const service = {
    status: 'idle',
    error: null,
    _index: null,
    _loadPromise: null,
    _loadMs: 0,
  };

  function stats() {
    if (service.status !== 'ready' || !service._index) return null;
    return {
      status: service.status,
      size: service._index.size,
      documents: service._index.documents,
      categories: service._index.categories,
      loadMs: service._loadMs,
    };
  }

  function load() {
    if (service._loadPromise) return service._loadPromise;
    service.status = 'loading';
    service.error = null;
    service._loadPromise = (async () => {
      const started = now();
      try {
        if (!fetchImpl) throw new Error('fetch is not available');
        const response = await fetchImpl(corpusUrl);
        if (!response || response.ok === false) {
          throw new Error(`加载语料失败: ${corpusUrl}`);
        }
        const corpus = typeof response.json === 'function' ? await response.json() : response;
        service._index = createKnowledgeIndex(corpus, indexOptions);
        service._loadMs = Math.max(0, Math.round(now() - started));
        service.status = 'ready';
      } catch (error) {
        service.error = error instanceof Error ? error : new Error(String(error));
        service.status = 'error';
        service._index = null;
        service._loadMs = Math.max(0, Math.round(now() - started));
      }
    })();
    return service._loadPromise;
  }

  function search(query, opts) {
    if (service.status !== 'ready' || !service._index) return [];
    return service._index.search(query, opts);
  }

  function answer(query, opts) {
    if (service.status !== 'ready' || !service._index) {
      return composeAnswer(typeof query === 'string' ? query : '', [], opts);
    }
    const hits = service._index.search(query, opts);
    return composeAnswer(query, hits, opts);
  }

  function suggest(query, opts) {
    if (service.status !== 'ready' || !service._index) return [];
    return service._index.suggest(query, opts);
  }

  function related(chunkId, opts) {
    if (service.status !== 'ready' || !service._index) return [];
    return service._index.related(chunkId, opts);
  }

  Object.assign(service, { stats, load, search, answer, suggest, related });
  return service;
}
