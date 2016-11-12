import redis from 'redis';
import logger from '../../logger';

const DEFAULT_REDIS_TTL = 30 * 1000; // 30 seconds in milliseconds

function debug() {
  logger.debug.apply(logger, ['RedisCacheAdapter', ...arguments]);
}

export class RedisCacheAdapter {

  constructor(ctx) {
    this.client = redis.createClient(ctx);
    this.p = Promise.resolve();
  }

  get(key) {
    debug('get', key);
    this.p = this.p.then(() => {
      return new Promise((resolve, _) => {
        this.client.get(key, function(err, res) {
          debug('-> get', key, res);
          if(!res) {
            return resolve(null);
          }
          resolve(JSON.parse(res));
        });
      });
    });
    return this.p;
  }

  put(key, value, ttl = DEFAULT_REDIS_TTL) {
    value = JSON.stringify(value);
    debug('put', key, value, ttl);
    if (ttl === 0) {
      return this.p; // ttl of zero is a logical no-op, but redis cannot set expire time of zero
    }
    if (ttl < 0 || isNaN(ttl)) {
      ttl = DEFAULT_REDIS_TTL;
    }
    this.p = this.p.then(() => {
      return new Promise((resolve, _) => {
        if (ttl === Infinity) {
          this.client.set(key, value, function(err, res) {
            resolve();
          });
        } else {
          this.client.psetex(key, ttl, value, function(err, res) {
            resolve();
          });
        }
      });
    });
    return this.p;
  }

  del(key) {
    debug('del', key);
    this.p = this.p.then(() => {
      return new Promise((resolve, _) => {
        this.client.del(key, function(err, res) {
          resolve();
        });
      });
    });
    return this.p;
  }

  clear() {
    debug('clear');
    this.p = this.p.then(() => {
      return new Promise((resolve, _) => {
        this.client.flushall(function(err, res) {
          resolve();
        });
      });
    });
    return this.p;
  }
}

export default RedisCacheAdapter;
