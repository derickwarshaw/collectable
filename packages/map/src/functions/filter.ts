import {Mutation, KeyedFilterFn} from '@collectable/core';
import {HashMapStructure} from '../internals/HashMap';
import {fold} from '../internals/primitives';
import {remove} from './remove';

export function filter<K, V>(fn: KeyedFilterFn<K, V>, map: HashMapStructure<K, V>): HashMapStructure<K, V> {
  map = Mutation.modify(map);
  fold(
    function(map: HashMapStructure<K, V>, value: V, key: K, index: number) {
      return fn(value, key, index) ? map : remove(key, map);
    },
    map, map, true
  );
  return Mutation.commit(map);
}
