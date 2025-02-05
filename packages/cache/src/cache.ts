import type {
  Cache,
  CacheTransaction,
  LiveCacheTransaction,
  CommittingTransaction,
  CacheEntry,
  CacheEntryState,
  CacheKeyValue,
  CachedEntityRevision,
  ExpirationPolicy,
  CacheOptions,
  DefaultRegistry,
  LruCache,
  CacheTransactionDebugAPIs,
} from './index.js';

class CacheImpl<
  CacheKeyRegistry extends DefaultRegistry,
  Key extends keyof CacheKeyRegistry,
  $Debug = unknown,
  UserExtensionData = unknown
> implements Cache<CacheKeyRegistry, Key, $Debug, UserExtensionData>
{
  #weakCache: Map<Key, WeakRef<CacheKeyRegistry[Key]>>;
  #entryRevisions: Map<Key, CachedEntityRevision<CacheKeyValue>[]>;
  #cacheOptions:
    | CacheOptions<CacheKeyRegistry, Key, $Debug, UserExtensionData>
    | undefined;
  #cacheEntryState: Map<Key, CacheEntryState<UserExtensionData> | undefined>;
  #lruCache: LruCacheImpl<CacheKeyRegistry, Key>;
  #lruPolicy: number;

  constructor(
    options:
      | CacheOptions<CacheKeyRegistry, Key, $Debug, UserExtensionData>
      | undefined
  ) {
    this.#weakCache = new Map<Key, WeakRef<CacheKeyRegistry[Key]>>();
    this.#cacheOptions = options;
    this.#lruPolicy = DEFAULT_EXPIRATION.lru;
    this.#entryRevisions = new Map<
      Key,
      CachedEntityRevision<CacheKeyValue>[]
    >();
    this.#cacheEntryState = new Map<
      Key,
      CacheEntryState<UserExtensionData> | undefined
    >();

    const expiration = this.#cacheOptions?.expiration || DEFAULT_EXPIRATION;
    if (expiration && expiration?.lru && typeof expiration.lru === 'number') {
      this.#lruPolicy = expiration.lru;
    }
    this.#lruCache = new LruCacheImpl<CacheKeyRegistry, Key>(this.#lruPolicy);
  }

  /**
    Evict all entries from the cache.
  */
  async clear(): Promise<void> {
    for await (const [key] of this.entries()) {
      this.#weakCache.delete(key);
      this.#lruCache.getCache().delete(key);
      this.#entryRevisions.delete(key);
    }
  }

  getCacheOptions():
    | CacheOptions<CacheKeyRegistry, Key, $Debug, UserExtensionData>
    | undefined {
    return this.#cacheOptions;
  }

  async get(cacheKey: Key): Promise<CacheKeyRegistry[Key] | undefined> {
    let ref = this.#weakCache.get(cacheKey);
    return ref?.deref();
  }

  /**
    Calling `.save()` without a serializer will iterate over the cache entries
    and return an array of cache entry tuples.
  */
  async save(): Promise<
    [
      Key,
      CacheKeyRegistry[Key],
      CacheEntryState<UserExtensionData> | undefined
    ][]
  > {
    const arrayOfCacheEntryTuples: [
      Key,
      CacheKeyRegistry[Key],
      CacheEntryState<UserExtensionData> | undefined
    ][] = [];
    for await (const [key, value, state] of this.entries()) {
      // TODO create state?
      const structuredClonedValue = structuredClone(
        value
      ) as CacheKeyRegistry[Key];
      arrayOfCacheEntryTuples.push([key, structuredClonedValue, state]);
    }
    return arrayOfCacheEntryTuples;
  }

  /**
    Calling `.load()` will add all entries passed to the cache.
    Note: `.load()` does not clear pre-existing entries, if you need to clear
    entries before loading call `.clear()`.
  */
  async load(
    entries: CacheEntry<CacheKeyRegistry, Key, UserExtensionData>[]
  ): Promise<void> {
    let revisionCounter = 0;
    for await (let entry of entries) {
      let [key, value, state] = entry;

      // TODO: finalizregistry
      let clone = structuredClone(value) as CacheKeyRegistry[Key];
      this.#weakCache.set(key, new WeakRef(clone));

      this.#lruCache.set(key, clone);
      this.#cacheEntryState.set(key, state);

      const entityRevision = {
        entity: value as CacheKeyValue,
        revision: ++revisionCounter,
      };
      if (this.#entryRevisions.has(key)) {
        const revisions =
          this.#entryRevisions.get(key)?.concat(entityRevision) || [];
        this.#entryRevisions.set(key, revisions);
      } else {
        this.#entryRevisions.set(key, [entityRevision]);
      }
    }
  }

  async commitTransaction(
    entries: CacheEntry<CacheKeyRegistry, Key, UserExtensionData>[],
    entryRevisions: Map<Key, CachedEntityRevision<CacheKeyValue>[]>
  ): Promise<void> {
    const sortEntries = entries.sort(([, , state], [, , state1]) =>
      state?.lastAccessed &&
      state1?.lastAccessed &&
      state?.lastAccessed < state1?.lastAccessed
        ? 1
        : -1
    );

    for await (let entry of sortEntries) {
      let [key, value, state] = entry;

      // TODO: finalizregistry
      this.#weakCache.set(key, new WeakRef(value));

      this.#cacheEntryState.set(key, state);

      if (state?.retained.lru) {
        this.#lruCache.set(key, value);
      }
    }

    for await (const [cacheKey, revision] of entryRevisions) {
      if (this.#entryRevisions.has(cacheKey)) {
        const revisions =
          this.#entryRevisions.get(cacheKey)?.concat(revision) || [];
        this.#entryRevisions.set(cacheKey, revisions);
      } else {
        this.#entryRevisions.set(cacheKey, revision);
      }
    }
  }

  /**
    Generator function for async iterable that yields iterable cache entries. This
    will include both strongly held (unexpired entries) as well as weakly held
    entries.
  */
  async *[Symbol.asyncIterator](): AsyncIterableIterator<
    [Key, CacheKeyRegistry[Key], CacheEntryState<UserExtensionData>]
  > {
    // yield weekly held values
    for await (const [key] of this.#weakCache) {
      const valueRef = this.#weakCache.get(key)?.deref();

      // Because of the limited guarantees of `FinalizationRegistry`, when yielding
      // weakly-held values to the user in `entries` we have to check that the
      // value is actually present,
      if (!valueRef) {
        throw new Error('ref is undefined');
      }

      const state = this.#cacheEntryState.get(key) || DEFAULT_ENTRY_STATE;

      yield [key, valueRef, state];
    }
  }

  /**
    Generator function that yields each of the iterable cache entries. Note that this
    will include both strongly held (unexpired entries) as well as weakly held
    entries.
  */
  entries(): AsyncIterableIterator<
    [Key, CacheKeyRegistry[Key], CacheEntryState<UserExtensionData>]
  > {
    return this[Symbol.asyncIterator]();
  }

  entryRevisions(
    cacheKey: Key
  ): AsyncIterableIterator<CachedEntityRevision<CacheKeyValue>> {
    const entryRevisionIterator = {
      async *[Symbol.asyncIterator](
        revisions: CachedEntityRevision<CacheKeyValue>[]
      ): AsyncIterableIterator<CachedEntityRevision<CacheKeyValue>> {
        for (const revision of revisions) {
          yield revision;
        }
      },
    };

    const revisions = this.#entryRevisions.get(cacheKey) || [];
    return entryRevisionIterator[Symbol.asyncIterator](revisions);
  }

  /**
   * Generator function that yields each of the iterable cache entry Keys.
   */
  async *keys(): AsyncIterableIterator<Key> {
    for await (const [key] of this.entries()) {
      yield key;
    }
  }

  /**
   * Generator function that yields each of the iterable cache entry Values.
   */
  async *values(): AsyncIterableIterator<CacheKeyRegistry[Key]> {
    for await (const [, value] of this.entries()) {
      yield value;
    }
  }

  async beginTransaction(): Promise<
    LiveCacheTransaction<CacheKeyRegistry, Key, $Debug, UserExtensionData>
  > {
    return await LiveCacheTransactionImpl.beginLiveTransaction(this);
  }
}

class LiveCacheTransactionImpl<
  CacheKeyRegistry extends DefaultRegistry,
  Key extends keyof CacheKeyRegistry,
  $Debug = unknown,
  UserExtensionData = unknown
> implements
    LiveCacheTransaction<CacheKeyRegistry, Key, $Debug, UserExtensionData>
{
  #originalCacheReference: CacheImpl<
    CacheKeyRegistry,
    Key,
    $Debug,
    UserExtensionData
  >;
  #transactionalCache: Map<Key, CacheKeyRegistry[Key]>;
  #localUpdatedEntries: Map<Key, CacheKeyRegistry[Key]>;
  #commitingTransaction: CommittingTransactionImpl<
    CacheKeyRegistry,
    Key,
    $Debug,
    UserExtensionData
  >;
  #cacheEntryState: Map<Key, CacheEntryState<UserExtensionData>>;
  #userOptionRetentionPolicy: ExpirationPolicy;
  #ttlPolicy: number;
  #lruPolicy: number;
  #localRevisions: Map<Key, CachedEntityRevision<CacheKeyValue>[]>;
  #entryRevisions: Map<Key, CachedEntityRevision<CacheKeyValue>[]>;

  constructor(
    originalCache: CacheImpl<CacheKeyRegistry, Key, $Debug, UserExtensionData>,
    transactionalCacheEntryMap: Map<Key, CacheKeyRegistry[Key]>,
    entryRevisions: Map<Key, CachedEntityRevision<CacheKeyValue>[]>
  ) {
    this.#originalCacheReference = originalCache;
    this.#transactionalCache = transactionalCacheEntryMap;
    this.#localUpdatedEntries = new Map<Key, CacheKeyRegistry[Key]>();
    this.#cacheEntryState = new Map<Key, CacheEntryState<UserExtensionData>>();
    this.#ttlPolicy = DEFAULT_EXPIRATION.ttl;
    this.#lruPolicy = DEFAULT_EXPIRATION.lru;

    this.#localRevisions = new Map<
      Key,
      CachedEntityRevision<CacheKeyValue>[]
    >();
    this.#entryRevisions = entryRevisions;

    this.#userOptionRetentionPolicy =
      this.#originalCacheReference.getCacheOptions()?.expiration ||
      DEFAULT_EXPIRATION;

    if (
      this.#userOptionRetentionPolicy &&
      this.#userOptionRetentionPolicy?.lru &&
      typeof this.#userOptionRetentionPolicy.lru === 'number'
    ) {
      this.#lruPolicy = this.#userOptionRetentionPolicy.lru;
    }

    if (
      this.#userOptionRetentionPolicy &&
      this.#userOptionRetentionPolicy?.ttl &&
      typeof this.#userOptionRetentionPolicy.ttl === 'number'
    ) {
      this.#ttlPolicy = this.#userOptionRetentionPolicy.ttl;
    }

    this.#commitingTransaction = new CommittingTransactionImpl<
      CacheKeyRegistry,
      Key,
      $Debug,
      UserExtensionData
    >();
  }

  static async beginLiveTransaction<
    CacheKeyRegistry extends DefaultRegistry,
    Key extends keyof CacheKeyRegistry,
    $Debug = unknown,
    UserExtensionData = unknown
  >(
    originalCache: CacheImpl<CacheKeyRegistry, Key, $Debug, UserExtensionData>
  ) {
    const transactionalCache = new Map<Key, CacheKeyRegistry[Key]>();
    const entryRevisions = new Map<
      Key,
      CachedEntityRevision<CacheKeyValue>[]
    >();
    for await (const [key, value] of originalCache.entries()) {
      transactionalCache.set(key, { ...value });

      for await (const entryRevision of originalCache.entryRevisions(key)) {
        entryRevisions.set(key, [entryRevision]);
      }
    }

    return new LiveCacheTransactionImpl<
      CacheKeyRegistry,
      Key,
      $Debug,
      UserExtensionData
    >(originalCache, transactionalCache, entryRevisions);
  }

  get(cacheKey: Key): CacheKeyRegistry[Key] | undefined {
    const cacheValue = this.#transactionalCache.get(cacheKey);

    if (cacheValue) {
      // Update cache entry state
      this.#cacheEntryState.set(cacheKey, {
        retained: { lru: true, ttl: this.#ttlPolicy },
        lastAccessed: Date.now(),
      });
    }

    return cacheValue;
  }

  async *[Symbol.asyncIterator](
    entryMap: Map<Key, CacheKeyRegistry[Key]>
  ): AsyncIterableIterator<
    [Key, CacheKeyRegistry[Key], CacheEntryState<UserExtensionData>]
  > {
    for (const [key, value] of entryMap) {
      const state = this.#cacheEntryState.get(key) || DEFAULT_ENTRY_STATE;
      yield [key, value, state];
    }
  }

  entries(): AsyncIterableIterator<
    [Key, CacheKeyRegistry[Key], CacheEntryState<UserExtensionData>]
  > {
    return this[Symbol.asyncIterator](this.#transactionalCache);
  }

  localEntries(): AsyncIterableIterator<
    [Key, CacheKeyRegistry[Key], CacheEntryState<UserExtensionData>]
  > {
    return this[Symbol.asyncIterator](this.#localUpdatedEntries);
  }

  localRevisions(
    cacheKey: Key
  ): AsyncIterableIterator<CachedEntityRevision<CacheKeyValue>> {
    const entryRevisionIterator = {
      async *[Symbol.asyncIterator](
        revisions: CachedEntityRevision<CacheKeyValue>[]
      ): AsyncIterableIterator<CachedEntityRevision<CacheKeyValue>> {
        for (const revision of revisions) {
          yield revision;
        }
      },
    };

    const revisions = this.#localRevisions.get(cacheKey) || [];
    return entryRevisionIterator[Symbol.asyncIterator](revisions);
  }

  entryRevisions(
    cacheKey: Key
  ): AsyncIterableIterator<CachedEntityRevision<CacheKeyValue>> {
    const entryRevisionIterator = {
      async *[Symbol.asyncIterator](
        revisions: CachedEntityRevision<CacheKeyValue>[]
      ): AsyncIterableIterator<CachedEntityRevision<CacheKeyValue>> {
        for (const revision of revisions) {
          yield revision;
        }
      },
    };

    const entryRevisions = this.#entryRevisions.get(cacheKey) || [];
    const localRevisions = this.#localRevisions.get(cacheKey) || [];

    return entryRevisionIterator[Symbol.asyncIterator](
      entryRevisions.concat(localRevisions)
    );
  }

  set(cacheKey: Key, value: CacheKeyRegistry[Key]): CacheKeyRegistry[Key] {
    this.#transactionalCache.set(cacheKey, value);
    this.#localUpdatedEntries.set(cacheKey, value);

    // Update cache entry state
    this.#cacheEntryState.set(cacheKey, {
      retained: { lru: true, ttl: this.#ttlPolicy },
      lastAccessed: Date.now(),
    });

    return value;
  }

  async delete(cacheKey: Key): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.#transactionalCache.has(cacheKey)) {
        this.#transactionalCache.delete(cacheKey);
      }

      if (this.#localUpdatedEntries.has(cacheKey)) {
        this.#localUpdatedEntries.delete(cacheKey);
      }

      return resolve(
        this.#transactionalCache.has(cacheKey) === false &&
          this.#localUpdatedEntries.has(cacheKey) === false
      );
    });
  }

  async merge(
    cacheKey: Key,
    entityRevision: CachedEntityRevision<CacheKeyValue>,
    options?: {
      $debug: $Debug;
    }
  ): Promise<CacheKeyRegistry[Key] | CacheKeyValue> {
    // assign custom merge strategy if specified else use default
    const mergeStrategyFromCacheOptionHook =
      this.#originalCacheReference.getCacheOptions()?.hooks
        ?.entitymergeStrategy;
    const mergeStrategy =
      mergeStrategyFromCacheOptionHook || defaultMergeStrategy;

    // get current cache value within this transaction
    const currentValue = this.#transactionalCache.get(cacheKey);

    const mergedEntity = mergeStrategy(
      cacheKey,
      {
        entity: entityRevision.entity,
        revision: entityRevision.revision,
        revisionContext: entityRevision?.revisionContext,
      },
      currentValue,
      this
    );

    // TODO throw error if Merge entity is undefined

    // Update transactional cache with merged entity
    this.set(cacheKey, mergedEntity as CacheKeyRegistry[Key]);

    // Update local & entry revisions with new revision values
    const revision = {
      entity: mergedEntity,
      revision: entityRevision.revision,
      revisionContext: entityRevision?.revisionContext,
    };
    if (this.#localRevisions.has(cacheKey)) {
      this.#localRevisions.get(cacheKey)?.push(revision);
    } else {
      this.#localRevisions.set(cacheKey, [revision]);
    }

    return mergedEntity;
  }

  async commit(options?: { timeout: number | false }): Promise<void> {
    const timeout: number = options?.timeout ? options.timeout : 10000;
    const commitLock = new Promise((resolve, reject) =>
      setTimeout(reject, timeout)
    );
    const writeToCache = async () => {
      const trasactionCacheEntries: [
        Key,
        CacheKeyRegistry[Key],
        CacheEntryState<UserExtensionData> | undefined
      ][] = [];

      for await (const [cacheKey, value, state] of this.localEntries()) {
        const latestCacheValue = await this.#originalCacheReference.get(
          cacheKey
        );
        let entityToCommit;

        // assign custom merge strategy if specified else use default
        const mergeStrategyFromCacheOptionHook =
          this.#originalCacheReference.getCacheOptions()?.hooks
            ?.entitymergeStrategy;
        const mergeStrategy =
          mergeStrategyFromCacheOptionHook || defaultMergeStrategy;

        if (latestCacheValue) {
          // TODO fix revision
          entityToCommit = mergeStrategy(
            cacheKey,
            { entity: value as CacheKeyValue, revision: 3 },
            latestCacheValue,
            this
          );
        } else {
          entityToCommit = value;
        }
        const structuredClonedValue = structuredClone(
          entityToCommit
        ) as CacheKeyRegistry[Key];

        trasactionCacheEntries.push([cacheKey, structuredClonedValue, state]);

        // Update saved revisions of the entity
        const localRevisions = this.#localRevisions.get(cacheKey);
        let revisionNumber =
          localRevisions && localRevisions[localRevisions.length - 1].revision
            ? localRevisions[localRevisions.length - 1].revision
            : 0;

        const entityRevision = {
          entity: entityToCommit as CacheKeyValue,
          revision: ++revisionNumber,
        };
        if (this.#localRevisions.has(cacheKey)) {
          this.#localRevisions.get(cacheKey)?.push(entityRevision);
        } else {
          this.#localRevisions.set(cacheKey, [entityRevision]);
        }

        const revisionStrategy = this.#originalCacheReference.getCacheOptions()
          ?.hooks?.revisionMergeStrategy
          ? async (
              id: Key,
              commitTx: CommittingTransactionImpl<
                CacheKeyRegistry,
                Key,
                $Debug,
                UserExtensionData
              >,
              liveTx: LiveCacheTransactionImpl<
                CacheKeyRegistry,
                Key,
                $Debug,
                UserExtensionData
              >
            ) =>
              this.#originalCacheReference.getCacheOptions()?.hooks
                ?.revisionMergeStrategy
          : defaultRevisionStrategy;

        // Update revisions based on revision strategy
        await revisionStrategy(cacheKey, this.#commitingTransaction, this);
      }

      // Call commit hook to apply custom retention policies before commit (if passed by cache options)
      const customRetentionPolicy =
        this.#originalCacheReference.getCacheOptions()?.hooks?.commit;
      if (customRetentionPolicy) {
        customRetentionPolicy(this);
      }

      const mergedRevisions = this.#commitingTransaction.mergedRevisions();

      // commit merged transaction & revisions entries to main cache
      await this.#originalCacheReference.commitTransaction(
        trasactionCacheEntries,
        mergedRevisions
      );
    };

    await Promise.race([writeToCache(), commitLock]);
  }
}
class CommittingTransactionImpl<
  CacheKeyRegistry extends DefaultRegistry,
  Key extends keyof CacheKeyRegistry = keyof CacheKeyRegistry,
  $Debug = unknown,
  UserExtensionData = unknown
> implements
    CommittingTransaction<CacheKeyRegistry, Key, $Debug, UserExtensionData>
{
  $debug?: ($Debug & CacheTransactionDebugAPIs) | undefined;
  #mergedRevisions: Map<Key, CachedEntityRevision<CacheKeyValue>[]>;

  cache: {
    clearRevisions(
      tx: CommittingTransactionImpl<
        CacheKeyRegistry,
        Key,
        $Debug,
        UserExtensionData
      >,
      id: Key
    ): void;
    appendRevisions(
      tx: CommittingTransactionImpl<
        CacheKeyRegistry,
        Key,
        $Debug,
        UserExtensionData
      >,
      id: Key,
      revisions: CachedEntityRevision<CacheKeyValue>[]
    ): void;
  } = {
    clearRevisions(
      tx: CommittingTransactionImpl<
        CacheKeyRegistry,
        Key,
        $Debug,
        UserExtensionData
      >,
      id: Key
    ): void {
      tx.#mergedRevisions.delete(id);
    },

    appendRevisions(
      tx: CommittingTransactionImpl<
        CacheKeyRegistry,
        Key,
        $Debug,
        UserExtensionData
      >,
      id: Key,
      revisions: CachedEntityRevision<CacheKeyValue>[]
    ): void {
      if (tx.#mergedRevisions.has(id)) {
        const appendedRevisions =
          tx.#mergedRevisions.get(id)?.concat(revisions) || [];
        tx.#mergedRevisions.set(id, appendedRevisions);
      } else {
        tx.#mergedRevisions.set(id, revisions);
      }
    },
  };

  constructor() {
    this.#mergedRevisions = new Map<
      Key,
      CachedEntityRevision<CacheKeyValue>[]
    >();
  }

  [Symbol.asyncIterator](
    entryMap: Map<Key, CacheKeyRegistry[Key]>
  ): AsyncIterableIterator<
    [Key, CacheKeyRegistry[Key], CacheEntryState<UserExtensionData>]
  > {
    throw new Error('Method not implemented.');
  }

  mergedRevisions(): Map<Key, CachedEntityRevision<CacheKeyValue>[]> {
    return this.#mergedRevisions;
  }
}

export function buildCache<
  CacheKeyRegistry extends DefaultRegistry = DefaultRegistry,
  Key extends keyof CacheKeyRegistry = keyof CacheKeyRegistry,
  $Debug = unknown,
  UserExtensionData = unknown
>(
  options?: CacheOptions<CacheKeyRegistry, Key, $Debug, UserExtensionData>
): Cache<CacheKeyRegistry, Key, $Debug, UserExtensionData> {
  return new CacheImpl<CacheKeyRegistry, Key, $Debug, UserExtensionData>(
    options
  );
}

class LruCacheImpl<
  CacheKeyRegistry extends DefaultRegistry,
  Key extends keyof CacheKeyRegistry
> implements LruCache<CacheKeyRegistry, Key>
{
  #max: number;
  #lruCache: Map<Key, CacheKeyRegistry[Key]>;

  constructor(maxCapacity: number) {
    this.#max = maxCapacity;
    this.#lruCache = new Map<Key, CacheKeyRegistry[Key]>();
  }

  set(cacheKey: Key, value: CacheKeyRegistry[Key]) {
    // refresh data
    if (this.#lruCache.has(cacheKey)) {
      this.#lruCache.delete(cacheKey);
    } else if (this.#lruCache.size === this.#max) {
      // find and evict the LRU entry
      const lruEntryKey = this.#lruCache.keys().next().value as Key;
      this.#lruCache.delete(lruEntryKey);
    }

    this.#lruCache.set(cacheKey, value);
  }

  getCache(): Map<Key, CacheKeyRegistry[Key]> {
    return this.#lruCache;
  }
}

const DEFAULT_EXPIRATION = { lru: 10000, ttl: 60000 };

const DEFAULT_ENTRY_STATE = {
  retained: { lru: false, ttl: DEFAULT_EXPIRATION.ttl },
};

const defaultMergeStrategy = function deepMergeStratey<
  CacheKeyRegistry extends DefaultRegistry,
  Key extends keyof CacheKeyRegistry
>(
  id: Key,
  { entity, revision }: CachedEntityRevision<CacheKeyValue>,
  current: CacheKeyRegistry[Key] | undefined,
  tx: CacheTransaction<CacheKeyRegistry, Key>
): CacheKeyValue {
  return deepMerge(current as CacheKeyValue, entity);
};

const defaultRevisionStrategy = async function retainAllRevisions<
  CacheKeyRegistry extends DefaultRegistry,
  Key extends keyof CacheKeyRegistry,
  $Debug = unknown,
  UserExtensionData = unknown
>(
  id: Key,
  commitTx: CommittingTransactionImpl<
    CacheKeyRegistry,
    Key,
    $Debug,
    UserExtensionData
  >,
  liveTx: LiveCacheTransactionImpl<
    CacheKeyRegistry,
    Key,
    $Debug,
    UserExtensionData
  >
): Promise<void> {
  const revisions: CachedEntityRevision<CacheKeyValue>[] = [];

  for await (const revision of liveTx.localRevisions(id)) {
    revisions.push(revision);
  }

  commitTx.cache.appendRevisions(commitTx, id, [...revisions]);
};

// eslint-disable-next-line
const isObject = function isObject(obj: any): obj is Record<string, any> {
  return obj !== null && !Array.isArray(obj) && typeof obj === 'object';
};

function deepMerge(
  targetData: CacheKeyValue,
  sourceData: CacheKeyValue
): CacheKeyValue {
  const source = isObject(sourceData) ? { ...sourceData } : sourceData;
  const target = isObject(targetData) ? { ...targetData } : targetData;

  if (isObject(source) && isObject(target)) {
    Object.keys(source).forEach((sourceKey) => {
      if (Object.prototype.hasOwnProperty.call(target, sourceKey)) {
        if (source[sourceKey] != target[sourceKey]) {
          // There is conflict that needs to be resolved
          const result = resolveConflict(target, source, sourceKey);

          if (result != target[sourceKey]) {
            target[sourceKey] = result;
          }
        }
      } else {
        // If there is no conflict, its safe, assign source to target
        target[sourceKey] = source[sourceKey];
      }
    });

    return target;
  }

  // If source or target is not an object use source.
  return source;
}

function resolveConflict(
  target: Record<string, object | string | number>,
  source: Record<string, object | string | number>,
  property: string
): CacheKeyValue {
  return deepMerge(
    target[property] as CacheKeyValue,
    source[property] as CacheKeyValue
  );
}

// eslint-disable-next-line
function structuredClone(x: any): any {
  try {
    return JSON.parse(JSON.stringify(x));
  } catch (error) {
    throw new Error(
      'The cache value is not structured clonable use `save` with serializer'
    );
  }
}
