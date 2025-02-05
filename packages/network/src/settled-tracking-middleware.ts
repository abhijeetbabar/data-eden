import type { MiddlewareMetadata, NormalizedFetch } from './fetch.js';

type Fetch = typeof fetch;

/**
  Debug information that is exposed via `getPendingRequestState(...)`.

  This is intended to provide enough information to be used to debug tests
  where requests are not completing as expected.
*/
export interface FetchDebugInfo {
  stack?: string;
  startTime: number;
  method: string;
  url: string;
}

const TrackingInfoPerFetch: WeakMap<Fetch, FetchDebugInfo[]> = new WeakMap();
const RequestsCompletedPromisesByToken: WeakMap<Fetch, InternalDeferred> =
  new WeakMap();

/**
  Exposes a mechanism that can be used to know if all requests that have
  been started with a given `buildFetch` result have completed.

  @example

  ```js
  import { hasPendingRequests } from '@data-eden/network';
  import { fetch } from './my-app-buildFetch';

  console.log(hasPendingRequests(fetch)) // => false;

  let result = fetch('/some-url');

  console.log(hasPendingRequests(fetch)) // => true;

  await result;

  console.log(hasPendingRequests(fetch)) // => false;
  ```
*/
export function hasPendingRequests(originatingFetch: Fetch): boolean {
  return getPendingRequestState(originatingFetch).length > 0;
}

/**
  Get an array of the currently pending requests for a given `fetch` function
  (e.g. `buildFetch` result).

  @example

  ```js
  import { getPendingRequestState } from '@data-eden/network';
  import { fetch } from './my-app-buildFetch';

  console.log(getPendingRequestState(fetch)) // => [];

  let result = fetch('/some-url');

  console.log(hasPendingRequests(fetch)) // =>
          [
            {
              "method": "GET",
              "stack": "Error:
              at SettledTrackingMiddleware (file:///packages/network/src/settled-tracking-middleware.ts)
              at file:///packages/network/src/fetch.ts",
              "startTime": 1675198640993,
              "url": "/some-url",
            },
          ]

  await result;

  console.log(getPendingRequestState(fetch)) // => [];
  ```
*/
export function getPendingRequestState(
  originatingFetch: Fetch
): FetchDebugInfo[] {
  const fetchDebugInfos = TrackingInfoPerFetch.get(originatingFetch);

  if (fetchDebugInfos === undefined) {
    return [];
  }

  return fetchDebugInfos;
}

export interface RequestsCompletedOptions {
  timeout?: number;
  timeoutMessagePrefix?: string;
}

export let defaultRequestsCompletedOptions: RequestsCompletedOptions;

export function _setupDefaultRequestsCompletedOptions(
  options?: RequestsCompletedOptions
) {
  defaultRequestsCompletedOptions = {
    timeout: 2_000,
    timeoutMessagePrefix:
      'requestsCompleted timeout waiting for requests to complete:',
    ...options,
  };
}
_setupDefaultRequestsCompletedOptions();

/**
  Exposes a mechanism to wait for all currently pending requests to
  be completed. This is useful in some testing contexts. For example,
  to know when any fetch related async is completed so that you can
  run various assertions on the results.

  @example

  ```js
  import { requestsCompleted } from '@data-eden/network';
  import { fetch } from './my-app-buildFetch';

  test('updates data when submitted', async function() {
    await render(...);

    await click('[some-button]');

    await requestsCompleted(fetch);

    expect(document.querySelector('.some-content').textContent).toMatchSnapshot();
  });
  ```
*/
export async function requestsCompleted(
  originatingFetch: Fetch,
  _options: RequestsCompletedOptions = {}
): Promise<unknown> {
  const options = { ...defaultRequestsCompletedOptions, ..._options };
  const deferred = RequestsCompletedPromisesByToken.get(originatingFetch);

  if (deferred) {
    let error = new Error(options.timeoutMessagePrefix);
    error.name = 'SETTLED_MIDDLEDWARE_REQUEST_COMPLETED_TIMEOUT';

    const timeout = new Promise((_resolve, reject) => {
      setTimeout(() => {
        let pendingRequests = getPendingRequestState(originatingFetch)
          .map(({ method, url }) => `  ${method} ${url}`)
          .join('\n');

        error.message += `\n${pendingRequests}`;
        reject(error);
      }, options.timeout);
    });

    return Promise.race([deferred.promise, timeout]);
  }
}

interface InternalDeferred {
  promise: Promise<unknown>;
  resolve: (value: void) => void;
}

function defer(): InternalDeferred {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((_resolve) => {
    resolve = _resolve;
  });

  return {
    promise,
    resolve,
  };
}

/**
  The primary goal of this middleware is to expose a mechanism for
  consumers to know when all requests are completed. This is **very**
  useful for testing purposes where you may want to author tests in a
  higher level way (e.g. "click this button and confirm some content
  is updated").

  Note: This middleware is intended to be used in non-production contexts
    (e.g. when debugging or running tests).

  @example
  ```js
  import { fetch } from '../network';
  import { requestsCompleted } from '@data-eden/network';

  test('updates data when submitted', async function() {
    await render(...);

    await click('[some-button]');

    await requestsCompleted(fetch);

    expect(document.querySelector('.some-content').textContent).toMatchSnapshot();
  });
  ```
*/
export default async function SettledTrackingMiddleware(
  request: Request,
  next: NormalizedFetch,
  metadata: MiddlewareMetadata
) {
  const error = new Error();

  const originatingFetch = metadata.fetch;

  let fetchDebugInfos = TrackingInfoPerFetch.get(originatingFetch);
  if (fetchDebugInfos === undefined) {
    fetchDebugInfos = [];
    TrackingInfoPerFetch.set(originatingFetch, fetchDebugInfos);
  }

  if (fetchDebugInfos.length === 0) {
    const deferred = defer();
    RequestsCompletedPromisesByToken.set(originatingFetch, deferred);
  }

  const debugInfo: FetchDebugInfo = {
    url: request.url,
    method: request.method,
    startTime: Date.now(),
    get stack() {
      return error.stack;
    },
  };

  fetchDebugInfos.push(debugInfo);

  try {
    return await next(request);
  } finally {
    const index = fetchDebugInfos.findIndex((item) => item === debugInfo);

    if (index === -1) {
      // eslint-disable-next-line no-unsafe-finally
      throw new Error(
        '[INTERNAL ERROR @data-eden/network]: Could not find debug information for a previously started request'
      );
    }
    fetchDebugInfos.splice(index, 1);

    if (fetchDebugInfos.length === 0) {
      const deferred = RequestsCompletedPromisesByToken.get(originatingFetch);

      if (deferred === undefined) {
        // eslint-disable-next-line no-unsafe-finally
        throw new Error(
          '[INTERNAL ERROR @data-eden/network]: Could not find requestsCompleted promise for a previously started request'
        );
      }

      deferred.resolve();
    }
  }
}
