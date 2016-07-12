var mssql = require('mssql');
var assert = require('assert');
var every = require('lodash.every');

var connectionParams = new WeakMap(); // Hidden connection parameters

module.exports = MssqlCrLayer;

/**
 * SQL Server common requests interface layer
 *
 *  @param config {object}
 * user: <username>,
 * password: <password>,
 * host: <host>,
 * pool: {
 *   max: <max pool size>,
 *   idleTimeout: <idle timeout in milliseconds>
 * }
 *
 * @returns {MssqlCrLayer}
 * @constructor
 */

function MssqlCrLayer(config) {
  if (!(this instanceof MssqlCrLayer)) {
    return new MssqlCrLayer(config);
  }
  connectionParams.set(this, toMssqlConfig(config));

  this.ISOLATION_LEVEL = config && config.ISOLATION_LEVEL || 'READ_COMMITTED';
}

MssqlCrLayer.prototype.dialect = 'mssql';

MssqlCrLayer.prototype.delimiters = '[]';

MssqlCrLayer.prototype.connect = function(config) {
  config = toMssqlConfig(config, connectionParams.get(this));
  var connections = this.connections = this.connections || new Map();
  var getConnectionKey = () => `${config.server}${config.port}${config.database}${config.user}`;
  var connection = connections.get(getConnectionKey());
  if (connection) {
    if (config.password === connection.config.password) {
      return Promise.resolve(connection.connection);
    }
    connection.connection.close();
  }
  connection = {};
  connection.config = Object.assign({}, config);
  connection.connection = new mssql.Connection(config);
  return connection.connection.connect()
    .then(() => {
      connections.set(getConnectionKey(), connection);
      return connection.connection;
    });
};

/**
 * Manage a transaction
 * @param fn(transaction)
 * fn should return a promise with commands that when resolved will be committed
 * or rolled back in case of an error. At each command you should pass
 * the transaction parameter as a transaction property in options
 * @param options {object} - Optional transaction level and database to connect
 * @returns {Promise} With the return of the last promise executed
 */
MssqlCrLayer.prototype.transaction = function(fn, options) {
  options = options || {};
  var isolationLevel = options.ISOLATION_LEVEL || this.ISOLATION_LEVEL;
  return this.connect(options)
    .then(function(connection) {
      var transaction = new mssql.Transaction(connection);
      var rolledBack = false;
      transaction.on('rollback', function() {
        rolledBack = true;
      });
      return transaction.begin(mssql.ISOLATION_LEVEL[isolationLevel])
        .then(function() {
          return fn(transaction);
        })
        .then(function(res) {
          return transaction.commit()
            .then(function() {
              return res;
            });
        })
        .catch(function(err) {
          if (!rolledBack) {
            return transaction.rollback()
              .then(function() {
                throw err;
              });
          }
          throw err;
        });
    });
};

const fold = record => { // tweak for node-mssql returning a array if you do a SELECT with a duplicate column name
  Object.keys(record)
    .forEach(key => {
      const value = record[key];
      if (Array.isArray(value) && value.length > 1) {
        const first = record[key][0];
        if (every(value, el => el === first)) {
          record[key] = first;
        }
      }
    });
  return record;
};

/**
 * Execute a script
 * @param script {string}
 * @param options {object} Can contain the transaction connection
 * @returns {Promise}
 */
MssqlCrLayer.prototype.batch = function(script, options) {
  var transaction = options && options.transaction;
  return (transaction ? Promise.resolve(transaction) : this.connect(options))
    .then(function(connection) {
      return (new mssql.Request(connection))
        .batch(script)
        .then(function(recordset) {
          return recordset ? recordset.map(fold) : [];
        });
    });
};

/**
 * Execute a command
 * @param statement {string}
 * @param params {Array|object} If array it will replace $1, $2... for each
 * element of the array. If object it will replace @key1, @key2 with the value with
 * each correspondent key
 * @param options {object} Can contain the transaction connection
 * @returns {Promise}
 */
MssqlCrLayer.prototype.execute = function(statement, params, options) {
  return this.query(statement, params, options);
};

/**
 * Execute a query
 * @param statement {string}
 * @param params {Array|object} If array it will replace $1, $2... for each
 * element of the array. If object it will replace @key1, @key2 with the value with
 * each correspondent key
 * @param options {object} Can contain the transaction connection
 * @returns {Promise}
 */
MssqlCrLayer.prototype.query = function(statement, params, options) {
  var transaction = options && options.transaction;
  var connect = transaction ? Promise.resolve(transaction) : this.connect(options);
  if (params === void 0 || params === null) {
    return connect
      .then(function(connection) {
        return (new mssql.Request(connection)).query(statement)
          .then(function(recordset) {
            return recordset ? recordset.map(fold) : [];
          });
      });
  }

  var convertParams = function() {
    if (Array.isArray(params)) {
      var match = statement.match(/(\$\w*\b)/g);
      assert((match && match.length || 0) <= Object.keys(params).length, 'There are more ' +
        'parameters in statement than in object params');
      var paramsObj = {};
      if (match) {
        match.map(function(param) {
          var key = param.substr(1);
          paramsObj['p' + key] = params[Number(key) - 1];
          statement = statement.replace(param, '@p' + key);
        });
      }
      params = paramsObj;
    }
  };

  var ps;
  var input = {};
  return connect
    .then(function(connection) {
      convertParams();
      ps = new mssql.PreparedStatement(connection);
      Object.keys(params).forEach(function(key) {
        var param = params[key];
        if (typeof param === 'object' && !(param instanceof Date)) {
          input[key] = param && param.value !== void 0 ? param.value : null;
          // Fix crash when inform a Date value and pass a string
          if (input[key] !== null &&
            (param.type === 'date' || param.type === 'datetime') && !(input[key] instanceof Date)) {
            input[key] = new Date(input[key]);
          }
          ps.input(key, getType(input[key], param));
        } else {
          input[key] = param !== void 0 ? param : null;
          if (input[key] instanceof Date) { // Fix mssql precision
            input[key] = input[key].toISOString().substring(0, 23) + '000';
          }
          ps.input(key, getType(input[key]));
        }
      });
    })
    .then(function() {
      return ps.prepare(statement);
    })
    .then(function() {
      return ps.execute(input)
        .then(function(recordset) {
          return ps.unprepare().then(function() {
            return recordset ? recordset.map(fold) : [];
          });
        })
        .catch(function(error) {
          return ps.unprepare().then(function() {
            throw error;
          });
        });
    });
};

/**
 * Close all connections in the poll
 * @returns {Promise}
 */
MssqlCrLayer.prototype.close = function() {
  var promise = Promise.resolve();
  this.connections.forEach(connection => {
    promise = promise.then(() => connection.connection.close());
  });
  this.connections = null;
  return promise;
};

/**
 * Wrap the identifier within the appropriate delimiters
 * @param identifier {string}
 * @returns identifier {string}
 */
MssqlCrLayer.prototype.wrap = function(identifier) {
  return this.delimiters[0] + identifier + this.delimiters[1];
};

function getType(value, param) {
  var type = mssql.NVarChar;
  if (param && param.type) {
    switch (param.type) {
      case 'integer':
        type = mssql.Int;
        break;
      case 'number':
        type = new mssql.Decimal(param.maxLength, param.decimals);
        break;
      case 'date':
        type = mssql.Date;
        break;
      case 'datetime':
        if (param.timezone === 'ignore') {
          type = mssql.DateTime2;
        } else {
          type = mssql.DateTimeOffset;
        }
        break;
      case 'string':
        if (param.maxLength) {
          type = new mssql.NVarChar(param.maxLength);
        }
    }
  } else {
    if (value instanceof Date) {
      type = mssql.DateTime2;
    } else if (typeof value === 'number') {
      type = new mssql.Decimal(('' + value).length, decimalPlaces(value));
    }
  }
  return type;
}

function decimalPlaces(num) {
  var match = ('' + num).match(/(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  return match ? Math.max(
    0,
    // Number of digits right of decimal point.
    (match[1] ? match[1].length : 0)
    // Adjust for scientific notation.
    - (match[2] ? +match[2] : 0)) : 0;
}

function toMssqlConfig(config, defaultConfig) {
  config = config || {};
  return {
    user: config.user || defaultConfig && defaultConfig.user,
    database: config.database || defaultConfig && defaultConfig.database,
    password: config.password || defaultConfig && defaultConfig.password,
    port: config.port || defaultConfig && defaultConfig.port || 1433,
    server: config.host || defaultConfig && defaultConfig.server || 'localhost',
    pool: {
      max: config.pool && config.pool.max ||
      defaultConfig && defaultConfig.pool && defaultConfig.pool.max,
      min: 0,
      idleTimeoutMillis: config.pool && config.pool.idleTimeout ||
      defaultConfig && defaultConfig.pool && defaultConfig.pool.idleTimeoutMillis
    }
  };
}

function sameDb(c1, c2) {
  return c1.user === c2.user &&
    c1.database === c2.database &&
    c1.server === c2.server &&
    c1.port === c2.port;
}

