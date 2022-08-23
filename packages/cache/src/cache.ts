// eslint-disable-next-line
function structuredClone(x: any): any {
  try {
    return JSON.parse(JSON.stringify(x));
  } catch (error) {
    throw new Error('The cache value is not structured clonable use `save` with serializer')
  }
}

type DefaultRegistry = Record<string, object>;
/**
  A 3-tuple of a cache entry that contains
  - *key*
  - *value*
  - *state* (optional)
*/
type CacheEntry<
  CacheKeyRegistry extends DefaultRegistry,
  Key extends keyof CacheKeyRegistry = keyof CacheKeyRegistry,
  UserExtensionData = unknown
  > = [
    key: Key,
    value: CacheKeyRegistry[Key],
    state?: CacheEntryState<UserExtensionData>
  ];

export interface CacheEntryState<UserExtensionData = unknown> {
  retained: {
    lru: boolean;
    ttl: number;
  };
  /**
  The last time this cache entry was accessed, either via `get`, `set`, or
  `merge`.

  Mainly useful for userland retention policies.
  */
  lastAccessed: number;
  extensions: UserExtensionData;
}

export interface Cache<
  CacheKeyRegistry extends DefaultRegistry,
  Key extends keyof CacheKeyRegistry = keyof CacheKeyRegistry,
  $Debug = unknown,
  UserExtensionData = unknown
  > {
  get(cacheKey: Key): Promise<CacheKeyRegistry[Key] | undefined>;

  /**
    Calling `.save()` without a serializer will iterate over the cache entries
    and return an array of cache entry tuples. The values contained within the
    tuples are copied via `structuredClone`.

    If your cache entries are not structured clonable, (e.g. a function)
    `.save()` will throw an error. In this case, use the alternate form of
    `.save` passing in a `CacheEntrySerializer`.

    @see <https://developer.mozilla.org/en-US/docs/Web/API/structuredClone>
  */
  save<Key extends keyof CacheKeyRegistry>(): Promise<[Key, CacheKeyRegistry[Key], CacheEntryState<UserExtensionData>][]>;

  /**
    Calling `.load()` will add all entries passed to the cache.

    Note: `.load()` does not clear pre-existing entries, if you need to clear
    entries before loading call `.clear()`.
  */
  load(
    entries: CacheEntry<CacheKeyRegistry, Key, UserExtensionData>[]
  ): Promise<void>;

  [Symbol.asyncIterator]<Key extends keyof CacheKeyRegistry>(): AsyncIterableIterator<[Key, CacheKeyRegistry[Key], CacheEntryState<UserExtensionData>]>

  entries<Key extends keyof CacheKeyRegistry>(): AsyncIterableIterator<[Key, CacheKeyRegistry[Key], CacheEntryState<UserExtensionData>]>;

  keys<Key extends keyof CacheKeyRegistry>(): AsyncIterableIterator<Key>;

  values<Key extends keyof CacheKeyRegistry>(): AsyncIterableIterator<CacheKeyRegistry[Key]>;
}

class CacheImpl<
  CacheKeyRegistry extends DefaultRegistry,
  Key extends keyof CacheKeyRegistry = keyof CacheKeyRegistry,
  $Debug = unknown,
  UserExtensionData = unknown
  > implements Cache<CacheKeyRegistry, Key, $Debug, UserExtensionData>
{
  #weakCache = new Map<Key, WeakRef<CacheKeyRegistry[Key]>>();
  // TODO: impl lru correctly
  #lru = new Map();

  async get(cacheKey: Key): Promise<CacheKeyRegistry[Key] | undefined> {
    let ref = this.#weakCache.get(cacheKey);
    return ref?.deref();
  }

  /**
    Calling `.load()` will add all entries passed to the cache.

    Note: `.load()` does not clear pre-existing entries, if you need to clear
    entries before loading call `.clear()`.
  */
  async load(
    entries: CacheEntry<CacheKeyRegistry, Key, UserExtensionData>[]
  ): Promise<void> {
    for await (let entry of entries) {
      let [key, value] = entry;
      // TODO: finalizregistry
      // let clone = structuredClone(value) as CacheKeyRegistry[Key];
      let clone = value;
      this.#weakCache.set(key, new WeakRef(clone));
      // TODO: impl lru correctly
      this.#lru.set(key, value);
    }
  }

  /**
    Generator function for async iterable that yields iterable cache entries. This
    will include both strongly held (unexpired entries) as well as weakly held
    entries.
  */
  async *[Symbol.asyncIterator]<Key extends keyof CacheKeyRegistry>(): AsyncIterableIterator<[Key, CacheKeyRegistry[Key], CacheEntryState<UserExtensionData>]> {
    for await (const [key] of this.#weakCache) {
      let ref = this.#weakCache.get(key)?.deref();
      // TODO read CacheEntryState correctly
      let state = undefined;
      yield [key as unknown as Key, ref as unknown as CacheKeyRegistry[Key], state as unknown as CacheEntryState<UserExtensionData>];
    }
  }

  /**
    Generator function that yields each of the iterable cache entries. Note that this
    will include both strongly held (unexpired entries) as well as weakly held
    entries.
  */
  entries<Key extends keyof CacheKeyRegistry>(): AsyncIterableIterator<[Key, CacheKeyRegistry[Key], CacheEntryState<UserExtensionData>]> {
    return this[Symbol.asyncIterator]();
  }

 /**
  * Generator function that yields each of the iterable cache entry Keys.
  */
  async *keys<Key extends keyof CacheKeyRegistry>(): AsyncIterableIterator<Key> {
    for await (const [key] of this.entries()) {
      yield key as Key;
    } 
  }

 /**
  * Generator function that yields each of the iterable cache entry Values.
  */
  async *values<Key extends keyof CacheKeyRegistry>(): AsyncIterableIterator<CacheKeyRegistry[Key]> {
    for await (const [, value] of this.entries()) {
       yield value as CacheKeyRegistry[Key];
    } 
  }

  /**
    Calling `.save()` without a serializer will iterate over the cache entries
    and return an array of cache entry tuples. The values contained within the
    tuples are copied via `structuredClone`.

    If your cache entries are not structured clonable, (e.g. a function)
    `.save()` will throw an error. In this case, use the alternate form of
    `.save` passing in a `CacheEntrySerializer`.

    @see <https://developer.mozilla.org/en-US/docs/Web/API/structuredClone>
  */
  async save<Key extends keyof CacheKeyRegistry>(): Promise<[Key, CacheKeyRegistry[Key], CacheEntryState<UserExtensionData>][]> {
    const arrayOfCacheEntryTuples: [Key, CacheKeyRegistry[Key], CacheEntryState<UserExtensionData>][] = [];
    for await (const [key, value, state] of this.entries()) {
      const structuredClonedValue = structuredClone(value) as CacheKeyRegistry[Key];
      arrayOfCacheEntryTuples.push([key as Key, structuredClonedValue, state])
    } 
    return arrayOfCacheEntryTuples;
  }
}


export function buildCache<
  CacheKeyRegistry extends DefaultRegistry = DefaultRegistry,
  Key extends keyof CacheKeyRegistry = keyof CacheKeyRegistry,
  $Debug = unknown,
  UserExtensionData = unknown
>(): Cache<CacheKeyRegistry, Key, $Debug, UserExtensionData> {
  return new CacheImpl<CacheKeyRegistry, Key, $Debug, UserExtensionData>();
}
