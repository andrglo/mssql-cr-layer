const mssql = require('mssql')
const assert = require('assert')
const every = require('lodash.every')
const debug = require('debug')('layer:mssql')
const scanMarkers = require('./scan-markers')

const connectionParams = new WeakMap() // Hidden connection parameters

// Tag a DB error with the SQL + params that produced it, so error-alert
// consumers can show what actually failed (drivers report code/number/state but
// never the statement itself). Set-if-absent: the innermost runner wins and
// outer wrappers never clobber a more specific capture. SQL is truncated so a
// giant generated statement can't blow past downstream storage caps.
const MAX_SQL_LENGTH = 4 * 1024

function attachSqlToError(err, sql, params) {
  if (!err || typeof err !== 'object') {
    return err
  }
  if (err.sql == null && typeof sql === 'string') {
    err.sql =
      sql.length > MAX_SQL_LENGTH
        ? sql.slice(0, MAX_SQL_LENGTH) + ' …(truncated)'
        : sql
  }
  if (err.params == null && params != null) {
    err.params = params
  }
  return err
}

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
            .catch(err => {
              debug('%s %O', script, err)
              throw attachSqlToError(err, script)
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
          .catch(err => {
            debug('%s %O', statement, err)
            throw attachSqlToError(err, statement)
          })
    })
  }

  const convertParams = function() {
    if (Array.isArray(params)) {
      const markers = scanMarkers(statement)
      assert(
          markers.length <= Object.keys(params).length,
          'There are more ' + 'parameters in statement than in object params'
      )
      const paramsObj = {}
      // rewrite by position: replacing by token would hit the first
      // occurrence anywhere in the statement, comments and literals included
      let converted = ''
      let last = 0
      markers.forEach(function(marker) {
        const key = marker.name
        paramsObj['p' + key] = params[Number(key) - 1]
        converted += statement.slice(last, marker.index) + '@p' + key
        last = marker.index + marker.length
      })
      statement = converted + statement.slice(last)
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
            ps.input(key, getType(input[key], param))
          } else {
            input[key] = param !== void 0 ? param : null
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
      .catch(err => {
        debug('%s %O', statement, err)
        throw attachSqlToError(err, statement, params)
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
 * Wrap the identifier within the appropriate delimiters, escaping the
 * closing delimiter by doubling it - the standard SQL escape - so an
 * identifier holding a delimiter cannot close the quoted context and
 * append arbitrary SQL. A NUL character cannot be escaped by any
 * delimiter style, so it is rejected, as is a non string identifier
 * @param identifier {string}
 * @returns identifier {string}
 */
MssqlCrLayer.prototype.wrap = function(identifier) {
  if (typeof identifier !== 'string') {
    throw new Error(
      'Invalid identifier: a string is expected, got ' + typeof identifier
    )
  }
  if (identifier.indexOf('\0') !== -1) {
    throw new Error(
      'Invalid identifier: the NUL character is not allowed'
    )
  }
  // delimiters is a prototype property a consumer can override. Read it once
  // and check it here, at the point of use: anything but a two character
  // string leaves close undefined or hijackable via Symbol.split, and the
  // escape below silently becomes a no op
  const delimiters = this.delimiters
  if (typeof delimiters !== 'string' || delimiters.length !== 2) {
    throw new Error(
      'Invalid delimiters: a two character string is expected'
    )
  }
  const open = delimiters[0]
  const close = delimiters[1]
  return open + identifier.split(close).join(close + close) + close
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
        if (param.timezone === true) {
          type = mssql.DateTimeOffset
        } else {
          type = mssql.DateTime2
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
    } else if (typeof value === 'boolean') {
      type = mssql.Bit
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
