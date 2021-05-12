const mssql = require('mssql')
const assert = require('assert')
const every = require('lodash.every')

const connectionParams = new WeakMap() // Hidden connection parameters

module.exports = MssqlCrLayer

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
    return new MssqlCrLayer(config)
  }
  const mssqlConfig = toMssqlConfig(config)
  connectionParams.set(this, mssqlConfig)
  this.user = mssqlConfig.user
  this.database = mssqlConfig.database
  this.host = mssqlConfig.server
  this.port = mssqlConfig.port
  this.ISOLATION_LEVEL = (config && config.ISOLATION_LEVEL) || 'READ_COMMITTED'
}

MssqlCrLayer.prototype.dialect = 'mssql'

MssqlCrLayer.prototype.delimiters = '[]'

MssqlCrLayer.prototype.connect = function() {
  const config = connectionParams.get(this)
  const connections = (this.connections = this.connections || new Map())
  const getConnectionKey = () =>
    `${config.server}${config.port}${config.database}${config.user}`
  let connection = connections.get(getConnectionKey())
  if (connection) {
    if (config.password === connection.config.password) {
      return Promise.resolve(connection.connection)
    }
    connection.connection.close()
  }
  connection = {}
  connection.config = Object.assign({}, config)
  connection.connection = new mssql.ConnectionPool(config)
  return connection.connection.connect().then(() => {
    connections.set(getConnectionKey(), connection)
    return connection.connection
  })
}

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
  options = options || {}
  const isolationLevel = options.ISOLATION_LEVEL || this.ISOLATION_LEVEL
  return this.connect().then(function(connection) {
    const transaction = new mssql.Transaction(connection)
    let rolledBack = false
    transaction.on('rollback', function() {
      rolledBack = true
    })
    return transaction
        .begin(mssql.ISOLATION_LEVEL[isolationLevel])
        .then(function() {
          return fn(transaction)
        })
        .then(function(res) {
          return transaction.commit().then(function() {
            return res
          })
        })
        .catch(function(err) {
          if (!rolledBack) {
            return transaction.rollback().then(function() {
              throw err
            })
          }
          throw err
        })
  })
}

const rolledBack = new WeakMap()

MssqlCrLayer.prototype.beginTransaction = function(options) {
  options = options || {}
  const isolationLevel = options.ISOLATION_LEVEL || this.ISOLATION_LEVEL
  return this.connect().then(function(connection) {
    const transaction = new mssql.Transaction(connection)
    rolledBack.set(transaction, false)
    transaction.on('rollback', function() {
      rolledBack.set(transaction, true)
    })
    return transaction
        .begin(mssql.ISOLATION_LEVEL[isolationLevel])
        .then(function() {
          return transaction
        })
  })
}

MssqlCrLayer.prototype.commit = function(transaction) {
  return transaction.commit().catch(function(err) {
    if (!rolledBack.get(transaction)) {
      return transaction.rollback().then(function() {
        throw err
      })
    }
    throw err
  })
}

MssqlCrLayer.prototype.rollback = function(transaction) {
  return rolledBack.get(transaction)
    ? Promise.resolve()
    : transaction.rollback()
}

const fold = record => {
  // tweak for node-mssql returning a array if you do a SELECT with a duplicate column name
  Object.keys(record).forEach(key => {
    const value = record[key]
    if (Array.isArray(value) && value.length > 1) {
      const first = record[key][0]
      if (every(value, el => el === first)) {
        record[key] = first
      }
    }
  })
  return record
}

/**
 * Execute a script
 * @param script {string}
 * @param options {object} Can contain the transaction connection
 * @returns {Promise}
 */
MssqlCrLayer.prototype.batch = function(script, options) {
  const transaction = options && options.transaction
  return (transaction ? Promise.resolve(transaction) : this.connect()).then(
      function(connection) {
        return new mssql.Request(connection)
            .batch(script)
            .then(function({recordset}) {
              return recordset ? recordset.map(fold) : []
            })
      }
  )
}

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
  return this.query(statement, params, options)
}

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
  const transaction = options && options.transaction
  const connect = transaction ? Promise.resolve(transaction) : this.connect()
  if (params === void 0 || params === null) {
    return connect.then(function(connection) {
      return new mssql.Request(connection)
          .query(statement)
          .then(function({recordset}) {
            return recordset ? recordset.map(fold) : []
          })
    })
  }

  const convertParams = function() {
    if (Array.isArray(params)) {
      const match = statement.match(/(\$\w*\b)/g)
      assert(
          ((match && match.length) || 0) <= Object.keys(params).length,
          'There are more ' + 'parameters in statement than in object params'
      )
      const paramsObj = {}
      if (match) {
        match.map(function(param) {
          const key = param.substr(1)
          paramsObj['p' + key] = params[Number(key) - 1]
          statement = statement.replace(param, '@p' + key)
        })
      }
      params = paramsObj
    }
  }

  let ps
  const input = {}
  return connect
      .then(function(connection) {
        convertParams()
        ps = new mssql.PreparedStatement(connection)
        Object.keys(params).forEach(function(key) {
          const param = params[key]
          if (typeof param === 'object' && !(param instanceof Date)) {
            input[key] = param && param.value !== void 0 ? param.value : null
            // Fix crash when inform a Date value and pass a string
            if (
              input[key] !== null &&
            (param.type === 'date' || param.type === 'datetime') &&
            !(input[key] instanceof Date)
            ) {
              input[key] = new Date(input[key])
            }
            ps.input(key, getType(input[key], param))
          } else {
            input[key] = param !== void 0 ? param : null
            if (input[key] instanceof Date) {
            // Fix mssql precision
              input[key] = input[key].toISOString().substring(0, 23) + '000'
            }
            ps.input(key, getType(input[key]))
          }
        })
      })
      .then(function() {
        return ps.prepare(statement)
      })
      .then(function() {
        return ps
            .execute(input)
            .then(function({recordset}) {
              return ps.unprepare().then(function() {
                return recordset ? recordset.map(fold) : []
              })
            })
            .catch(function(error) {
              return ps.unprepare().then(function() {
                throw error
              })
            })
      })
}

/**
 * Close all connections in the poll
 * @returns {Promise}
 */
MssqlCrLayer.prototype.close = function() {
  let promise = Promise.resolve()
  if (this.connections) {
    this.connections.forEach(connection => {
      promise = promise.then(() => connection.connection.close())
    })
  }
  this.connections = null
  return promise
}

/**
 * Wrap the identifier within the appropriate delimiters
 * @param identifier {string}
 * @returns identifier {string}
 */
MssqlCrLayer.prototype.wrap = function(identifier) {
  return this.delimiters[0] + identifier + this.delimiters[1]
}

function getType(value, param) {
  let type = mssql.NVarChar
  if (param && param.type) {
    switch (param.type) {
      case 'integer':
        type = mssql.Int
        break
      case 'number':
        type = mssql.Decimal(param.maxLength, param.decimals)
        break
      case 'date':
        type = mssql.Date
        break
      case 'datetime':
        if (param.timezone === 'ignore') {
          type = mssql.DateTime2
        } else {
          type = mssql.DateTimeOffset
        }
        break
      case 'string':
        if (param.maxLength) {
          type = mssql.NVarChar(param.maxLength)
        }
    }
  } else {
    if (value instanceof Date) {
      type = mssql.DateTime2
    } else if (typeof value === 'number') {
      type = mssql.Decimal(('' + value).length, decimalPlaces(value))
    }
  }
  return type
}

function decimalPlaces(num) {
  const match = ('' + num).match(/(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/)
  return match
    ? Math.max(
        0,
        // Number of digits right of decimal point.
        (match[1] ? match[1].length : 0) -
          // Adjust for scientific notation.
          (match[2] ? +match[2] : 0)
    )
    : 0
}

function toMssqlConfig(config) {
  const mssqlConfig = {
    port: 1433,
    server: config.host || 'localhost',
    requestTimeout: 6000,
    ...config || {},
    pool: {
      min: 0
    },
    options: {
      encrypt: false,
      enableArithAbort: false,
      ...config.options || {},
    }
  }
  if (config.pool) {
    mssqlConfig.pool = {...mssqlConfig.pool, ...config.pool}
    if (mssqlConfig.pool.idleTimeout) {
      mssqlConfig.pool.idleTimeoutMillis = mssqlConfig.pool.idleTimeout
      delete mssqlConfig.pool.idleTimeout
    }
  }
  return mssqlConfig
}
