import { md5Hash, newObjectId } from './cryptoUtils';
import { logger }               from './logger';
import _ from 'lodash';

const PUSH_STATUS_COLLECTION = '_PushStatus';
const JOB_STATUS_COLLECTION = '_JobStatus';
const PUSH_COLLECTION = 'Push';

export function flatten(array) {
  return array.reduce((memo, element) => {
    if (Array.isArray(element)) {
      memo = memo.concat(flatten(element));
    } else {
      memo = memo.concat(element);
    }
    return memo;
  }, []);
}

function statusHandler(className, database) {
  let lastPromise = Promise.resolve();

  function create(object) {
    lastPromise = lastPromise.then(() => {
      return database.create(className, object).then(() => {
        return Promise.resolve(object);
      });
    });
    return lastPromise;
  }

  function update(where, object) {
    lastPromise = lastPromise.then(() => {
      return database.update(className, where, object);
    });
    return lastPromise;
  }

  function createPush(object) {
    lastPromise = lastPromise.then(() => {
      return database.create(PUSH_COLLECTION, object).then(() => {
        return Promise.resolve(object);
      });
    });
    return lastPromise;
  }

  function updatePush(query, updateFields) {
    lastPromise = lastPromise.then(() => {
      return database.update(PUSH_COLLECTION, query, updateFields);
    });
    return lastPromise;
  }

  function insertPushes(pushStatusObjectId, installations) {
    console.log('insertPushes'); // For debugging, remove

    // Insert a Push object for each installation we're pushing to
    let now = new Date();
    let promises = _.map(installations, installation => {
      let pushObjectId = newObjectId();
      let push = {
        objectId: pushObjectId,
        createdAt: now,
        updatedAt: now,
        deviceToken: installation.deviceToken,
        installation: {
          __type: 'Pointer',
          className: "_Installation",
          objectId: installation.objectId,
        },
        pushStatus: pushStatusObjectId
      };
      return createPush(push);
    });
    return Promise.all(promises);
  }

  function updatePushes(pushStatusObjectId, installations, results) {
    console.log('updatePushes'); // For debugging, remove
    let now = new Date();

    // For debugging, remove
    _.forEach(results, result => {
      console.log('result', result);
    });

    let resultsByDeviceToken = _.keyBy(results, r => r.device.deviceToken);

    // Update the push record for each installation
    let promises = _.map(installations, installation => {
      let deviceToken = installation.deviceToken;
      let result = null;

      // Handle different failure scenarios
      if (!deviceToken) {
        result = { transmitted: false, error: 'No deviceToken found on installation' }
      } else if (deviceToken in resultsByDeviceToken) {
        result = resultsByDeviceToken[deviceToken];
      } else {
        result = { transmitted: false, error: 'No result from adapter' }
      }

      // Find the record to update
      let query = {
        pushStatus: pushStatusObjectId,
        installation: {
          __type: 'Pointer',
          className: "_Installation",
          objectId: installation.objectId,
        }
      };
      let updateFields = { result: result, updatedAt: now };

      return updatePush(query, updateFields);
    });

    return Promise.all(promises);
  }

  return Object.freeze({
    create,
    update,
    createPush,
    updatePush,
    insertPushes,
    updatePushes
  })
}

export function jobStatusHandler(config) {
  let jobStatus;
  let objectId = newObjectId();
  let database = config.database;
  let lastPromise = Promise.resolve();
  let handler = statusHandler(JOB_STATUS_COLLECTION, database);
  let setRunning = function(jobName, params) {
    let now = new Date();
    jobStatus = {
      objectId,
      jobName,
      params,
      status: 'running',
      source: 'api',
      createdAt: now,
      // lockdown!
      ACL: {}
    }

    return handler.create(jobStatus);
  }

  let setMessage = function(message) {
    if (!message || typeof message !== 'string') {
      return Promise.resolve();
    }
    return handler.update({ objectId }, { message });
  }

  let setSucceeded = function(message) {
    return setFinalStatus('succeeded', message);
  }

  let setFailed = function(message) {
    return setFinalStatus('failed', message);
  }

  let setFinalStatus = function(status, message = undefined) {
    let finishedAt = new Date();
    let update = { status, finishedAt };
    if (message && typeof message === 'string') {
      update.message = message;
    }
    return handler.update({ objectId }, update);
  }

  return Object.freeze({
    setRunning,
    setSucceeded,
    setMessage,
    setFailed
  });
}

export function pushStatusHandler(config) {

  let pushStatus;
  let objectId = newObjectId();
  let database = config.database;
  let handler = statusHandler(PUSH_STATUS_COLLECTION, database);
  let setInitial = function(body = {}, where, options = {source: 'rest'}) {
    let now = new Date();
    let data =  body.data || {};
    let payloadString = JSON.stringify(data);
    let pushHash;
    if (typeof data.alert === 'string') {
      pushHash = md5Hash(data.alert);
    } else if (typeof data.alert === 'object') {
      pushHash = md5Hash(JSON.stringify(data.alert));
    } else {
      pushHash = 'd41d8cd98f00b204e9800998ecf8427e';
    }
    let object = {
      objectId,
      createdAt: now,
      pushTime: now.toISOString(),
      query: JSON.stringify(where),
      payload: payloadString,
      source: options.source,
      title: options.title,
      expiry: body.expiration_time,
      status: "pending",
      numSent: 0,
      pushHash,
      // lockdown!
      ACL: {}
    }

    return handler.create(object).then(() => {
      pushStatus = {
        objectId
      };
      return Promise.resolve(pushStatus);
    });
  }

  let setRunning = function(installations) {
    logger.verbose('sending push to %d installations', installations.length);
    return handler.insertPushes(objectId, installations).then(() => {
      return handler.update({status:"pending", objectId: objectId},
        {status: "running", updatedAt: new Date() });
    });
  }

  let complete = function(data) {
    let results = data.results;
    let installations = data.installations;
    let update = {
      status: 'succeeded',
      updatedAt: new Date(),
      numSent: 0,
      numFailed: 0,
    };
    if (Array.isArray(results)) {
      results = flatten(results);
      results.reduce((memo, result) => {
        // Cannot handle that
        if (!result || !result.device || !result.device.deviceType) {
          return memo;
        }
        let deviceType = result.device.deviceType;
        if (result.transmitted)
        {
          memo.numSent++;
          memo.sentPerType = memo.sentPerType || {};
          memo.sentPerType[deviceType] = memo.sentPerType[deviceType] || 0;
          memo.sentPerType[deviceType]++;
        } else {
          memo.numFailed++;
          memo.failedPerType = memo.failedPerType || {};
          memo.failedPerType[deviceType] = memo.failedPerType[deviceType] || 0;
          memo.failedPerType[deviceType]++;
        }
        return memo;
      }, update);
    }
    logger.verbose('sent push! %d success, %d failures', update.numSent, update.numFailed);
    return handler.updatePushes(objectId, installations, results).then(() => {
      return handler.update({status:"running", objectId }, update);
    });
  }

  let fail = function(err) {
    let update = {
      errorMessage: JSON.stringify(err),
      status: 'failed',
      updatedAt: new Date()
    }
    logger.info('warning: error while sending push', err);
    return handler.update({ objectId }, update);
  }

  return Object.freeze({
    objectId,
    setInitial,
    setRunning,
    complete,
    fail
  })
}
