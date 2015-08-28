var mssql = require('mssql');
var assert = require('assert');
var debug = require('debug')('mssql-cr-layer');

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
  this.connection = new mssql.Connection({
    user: config.user,
    database: config.database,
    password: config.password,
    port: config.port,
    server: config.host,
    pool: {
      max: (config.pool && config.pool.max),
      min: 0,
      idleTimeoutMillis: (config.pool && config.pool.idleTimeout)
    }
  });
}

MssqlCrLayer.prototype.dialect = 'mssql';

MssqlCrLayer.prototype.delimiters = '[]';

MssqlCrLayer.prototype.connect = function() {
  return this.connection.connect();
};

/**
 * Manage a transaction
 * @param fn(transaction)
 * fn should return a promise with commands that when resolved will be committed
 * or rolled back in case of an error. At each command you should pass
 * the transaction parameter as a transaction property in options
 * @returns {Promise} With the return of the last promise executed
 */
MssqlCrLayer.prototype.transaction = function(fn) {
  var transaction = new mssql.Transaction(this.connection);
  var rolledBack = false;
  transaction.on('rollback', function() {
    rolledBack = true;
  });
  return transaction.begin()
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
};

/**
 * Execute a script
 * @param script {string}
 * @param options {object} Can contain the transaction connection
 * @returns {Promise}
 */
MssqlCrLayer.prototype.batch = function(script, options) {
  return (new mssql.Request((options && options.transaction) || this.connection))
    .batch(script)
    .then(function(recordset) {
      return recordset || [];
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

  debug('QUERY:', statement, params);

  var connection = (options && options.transaction) || this.connection;
  if (params === void 0 || params === null) {
    return (new mssql.Request(connection)).query(statement)
      .then(function(recordset) {
        return recordset || [];
      });
  }

  var convertParams = function() {
    if (Array.isArray(params)) {
      var match = statement.match(/(\$\w*\b)/g);
      assert(Array.isArray(match), 'No parameter is defined in statement');
      assert(match.length === params.length, 'Parameters in statement ' +
        'not match parameters in object params');
      debug(match);
      var paramsObj = {};
      match.map(function(param) {
        var key = param.substr(1);
        paramsObj['p' + key] = params[Number(key) - 1];
        statement = statement.replace(param, '@p' + key);
      });
      params = paramsObj;
      debug('params converted', statement, params);
    }
  };

  var ps;
  var input = {};
  return Promise.resolve()
    .then(function() {
      convertParams();
      ps = new mssql.PreparedStatement(connection);
      Object.keys(params).forEach(function(key) {
        var param = params[key];
        debug('input', key, param);
        input[key] = param.value || param;
        ps.input(key, getType(param));
      });
      debug('params typed');
    })
    .then(function() {
      return ps.prepare(statement);
    })
    .then(function() {
      debug('prepared');
      return ps.execute(input)
        .then(function(recordset) {
          debug('executed');
          return ps.unprepare().then(function() {
            return recordset || [];
          });
        })
        .catch(function(error) {
          debug('catch', statement, error);
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
  return this.connection.close();
};

/**
 * Wrap the identifier within the appropriate delimiters
 * @param identifier {string}
 * @returns identifier {string}
 */
MssqlCrLayer.prototype.wrap = function(identifier) {
  return this.delimiters[0] + identifier + this.delimiters[1];
};

function getType(param) {
  var type = mssql.NVarChar;
  debug('from type', param);
  if (param.type === void 0) {
    if (param instanceof Date) {
      type = mssql.DateTime2;
    } else if (typeof param === 'number') {
      type = mssql.Decimal;
    }
  } else {
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
  }
  debug('to type', type);
  return type;
}


