const MssqlCrLayer = require('../src')

const databaseName = [
  'tests-mssql-cr-layer-1',
  'tests-mssql-cr-layer-2',
  'tests-mssql-cr-layer-3'
]

const config = {
  user: process.env.MSSQL_USER || 'sa',
  password: process.env.MSSQL_PASSWORD,
  host: process.env.MSSQL_HOST || 'localhost',
  port: process.env.MSSQL_PORT || 1433,
  pool: {
    max: 25,
    idleTimeout: 30000
  },
  options: {
    enableArithAbort: true
  }
}

const createDbLayer = {}

function createMssqlDb(dbName) {
  config.database = 'master'
  createDbLayer[dbName] = new MssqlCrLayer(config) // do not close after creation
  return createDbLayer[dbName].connect().then(function() {
    return createDbLayer[dbName].execute(
        'IF EXISTS(select * from sys.databases where name=\'' +
        dbName +
        '\') DROP DATABASE [' +
        dbName +
        '];' +
        'CREATE DATABASE [' +
        dbName +
        '];' +
        'ALTER DATABASE [' +
        dbName +
        '] SET ALLOW_SNAPSHOT_ISOLATION ON;' +
        'ALTER DATABASE [' +
        dbName +
        '] SET READ_COMMITTED_SNAPSHOT ON'
    )
  })
}

let expect

before(function() {
  return import('chai').then(chai => {
    chai.should()
    expect = chai.expect
    return createMssqlDb(databaseName[0])
        .then(function() {
          return createMssqlDb(databaseName[1])
        })
        .then(function() {
          return createMssqlDb(databaseName[2])
        })
  })
})

describe('mssql cr layer', function() {
  let layer0
  let layer1
  let layer2
  before(function() {
    config.database = databaseName[0]
    layer0 = new MssqlCrLayer(config)
    config.database = databaseName[1]
    layer1 = new MssqlCrLayer(config)
    config.database = databaseName[2]
    layer2 = new MssqlCrLayer(config)
    return layer0
        .connect()
        .then(function() {
          return layer1.connect()
        })
        .then(function() {
          return layer2.connect()
        })
  })

  it('should create a table in layer 0', function(done) {
    layer0
        .execute(
            'CREATE TABLE films (' +
          'code char(5) CONSTRAINT firstkey PRIMARY KEY, ' +
          'title       varchar(40) NOT NULL, ' +
          'did integer NOT NULL, ' +
          'date_prod   date, ' +
          'kind varchar(10), ' +
          'len datetime )'
        )
        .then(function(res) {
          expect(res).to.be.a('array')
          expect(res.length).to.equal(0)
          done()
        })
        .catch(done)
  })
  it('film now exists in layer 0', function(done) {
    layer0
        .query('SELECT * FROM films')
        .then(function(recordset) {
          expect(recordset).to.be.a('array')
          expect(recordset.length).to.equal(0)
          done()
        })
        .catch(done)
  })
  it('film not exists in layer 1', function(done) {
    layer1
        .query('SELECT * FROM films')
        .then(function() {
          done(new Error('Table created in the wrong db'))
        })
        .catch(function(error) {
          expect(error.message.indexOf('Invalid object name') !== -1).to.equal(
              true
          )
          done()
        })
        .catch(done)
  })
  it('film not exists in layer 2', function(done) {
    layer1
        .query('SELECT * FROM films')
        .then(function() {
          done(new Error('Table created in the wrong db'))
        })
        .catch(function(error) {
          expect(error.message.indexOf('Invalid object name') !== -1).to.equal(
              true
          )
          done()
        })
        .catch(done)
  })
  it('should create a table in layer 1', function(done) {
    layer1
        .execute(
            'CREATE TABLE products ( ' +
          'product_no integer, ' +
          'name varchar(10), ' +
          'price numeric(12,2) )'
        )
        .then(function(res) {
          expect(res).to.be.a('array')
          expect(res.length).to.equal(0)
          done()
        })
        .catch(done)
  })
  it('should not create any record if a transaction fails in layer 1', function(done) {
    layer1
        .transaction(function(t) {
          return layer1
              .execute(
                  'INSERT INTO products ' + 'VALUES (1, \'Cheese\', 9.99)',
                  null,
                  {transaction: t}
              )
              .then(function() {
                return layer1.execute(
                    'INSERT INTO products ' + 'VALUES (2, \'Chicken\', 19.99)',
                    null,
                    {transaction: t}
                )
              })
              .then(function() {
                throw new Error('Crash')
              })
        })
        .then(function() {
          done(new Error('Where is the crash'))
        })
        .catch(function(error) {
          expect(error.message.indexOf('Crash') !== -1).to.equal(true)
          done()
        })
        .catch(done)
  })
  it('products should be empty in layer 1', function(done) {
    layer1
        .query('SELECT * FROM products')
        .then(function(recordset) {
          expect(recordset).to.be.a('array')
          expect(recordset.length).to.equal(0)
          done()
        })
        .catch(done)
  })
  it('should not create any record if we rollback a transaction in layer 1, using step by step control', function(done) {
    layer1
        .beginTransaction()
        .then(function(t) {
          return layer1
              .execute(
                  'INSERT INTO products ' + 'VALUES (1, \'Cheese\', 9.99)',
                  null,
                  {transaction: t}
              )
              .then(function() {
                return layer1.execute(
                    'INSERT INTO products ' + 'VALUES (2, \'Chicken\', 19.99)',
                    null,
                    {transaction: t}
                )
              })
              .then(function() {
                return layer1.rollback(t)
              })
              .then(function() {
                done()
              })
        })
        .catch(done)
  })
  it('products should be empty in layer 1', function(done) {
    layer1
        .query('SELECT * FROM products')
        .then(function(recordset) {
          expect(recordset).to.be.a('array')
          expect(recordset.length).to.equal(0)
          done()
        })
        .catch(done)
  })
  it('you can pass a empty params array', function(done) {
    layer1
        .query('SELECT * FROM products', [])
        .then(function(recordset) {
          expect(recordset).to.be.a('array')
          expect(recordset.length).to.equal(0)
          done()
        })
        .catch(done)
  })
  it('you can pass a empty params object', function(done) {
    layer1
        .query('SELECT * FROM products', {})
        .then(function(recordset) {
          expect(recordset).to.be.a('array')
          expect(recordset.length).to.equal(0)
          done()
        })
        .catch(done)
  })
  it('you can pass a params object with extra data', function(done) {
    layer1
        .query('SELECT * FROM products', {notuseful: false})
        .then(function(recordset) {
          expect(recordset).to.be.a('array')
          expect(recordset.length).to.equal(0)
          done()
        })
        .catch(done)
  })
  it('should create the two records when the transaction is ok in layer 1', function(done) {
    layer1
        .transaction(function(t) {
          return layer1
              .execute(
                  'INSERT INTO products ' + 'VALUES (1, \'Cheese\', 9.99)',
                  null,
                  {transaction: t}
              )
              .then(function() {
                return layer1.execute(
                    'INSERT INTO products ' + 'VALUES (2, \'Chicken\', 19.99)',
                    null,
                    {transaction: t}
                )
              })
        })
        .then(function(res) {
          expect(res).to.be.a('array')
          expect(res.length).to.equal(0)
          done()
        })
        .catch(done)
  })
  it('products should have two records in layer 1', function(done) {
    layer1
        .query('SELECT * FROM products')
        .then(function(recordset) {
          expect(recordset).to.be.a('array')
          expect(recordset.length).to.equal(2)
          done()
        })
        .catch(done)
  })
  it('should create more one record when no transaction and a fail occurs in layer 1', function(done) {
    layer1
        .execute('INSERT INTO products ' + 'VALUES (3, \'Wine\', 99.99)')
        .then(function() {
          throw new Error('Crash')
        })
        .then(function() {
          done(new Error('Where is the crash'))
        })
        .catch(function(error) {
          expect(error.message.indexOf('Crash') !== -1).to.equal(true)
          done()
        })
        .catch(done)
  })
  it('products should have three records in layer 1', function(done) {
    layer1
        .query('SELECT * FROM products')
        .then(function(recordset) {
          expect(recordset).to.be.a('array')
          expect(recordset.length).to.equal(3)
          done()
        })
        .catch(done)
  })
  it('products should return only one column', function(done) {
    layer1
        .query('SELECT name,name FROM products')
        .then(function(recordset) {
          recordset.forEach(record => {
            expect(Object.keys(record).length).to.equal(1)
            expect(record.name).to.be.a('string')
          })
          done()
        })
        .catch(done)
  })
  it('should not create any record if a transaction fails due the server in layer 1', function(done) {
    layer1
        .transaction(function(t) {
          return layer1
              .execute(
                  'INSERT INTO products ' + 'VALUES (4, \'Corn\', 39.99)',
                  null,
                  {transaction: t}
              )
              .then(function() {
                return layer1.execute(
                    'INSERT INTO products ' +
                'VALUES (5, \'Very long product name\', 19.99)',
                    null,
                    {transaction: t}
                )
              })
        })
        .then(function() {
          done(new Error('The server accepted?'))
        })
        .catch(function(error) {
          expect(
              error.message.indexOf('data would be truncated') !== -1
          ).to.equal(true)
          done()
        })
        .catch(done)
  })
  it('products should still have three records in layer 1', function(done) {
    layer1
        .query('SELECT * FROM products')
        .then(function(recordset) {
          expect(recordset).to.be.a('array')
          expect(recordset.length).to.equal(3)
          done()
        })
        .catch(done)
  })
  it('should wrap a identifier with brackets', function() {
    expect(layer0.wrap('abc')).to.equal('[abc]')
  })
  it('should have postgres as dialect', function() {
    expect(layer0.dialect).to.equal('mssql')
  })
  it('should create more one record¬ using array parameters in layer 1', function(done) {
    layer1
        .execute('INSERT INTO products ' + 'VALUES ($1, $2, $3)', [
          4,
          'Corn',
          59.99
        ])
        .then(function(res) {
          expect(res).to.be.a('array')
          expect(res.length).to.equal(0)
          done()
        })
        .catch(done)
  })
  it('products should have four records in layer 1', function(done) {
    layer1
        .query('SELECT * FROM products')
        .then(function(recordset) {
          expect(recordset).to.be.a('array')
          expect(recordset.length).to.equal(4)
          done()
        })
        .catch(done)
  })
  it('should create more one record using object parameters in layer 1', function() {
    return layer1
        .execute(
            'INSERT INTO products ' + 'VALUES (@product_no, @name, @price)',
            {
              name: 'Duck',
              product_no: 5,
              price: 0.99
            }
        )
        .then(function(res) {
          expect(res).to.be.a('array')
          expect(res.length).to.equal(0)
        })
  })
  it('products should have five records in layer 1', function(done) {
    layer1
        .query('SELECT * FROM products')
        .then(function(recordset) {
          expect(recordset).to.be.a('array')
          expect(recordset.length).to.equal(5)
          const record = recordset[0]
          expect(record.product_no).to.be.a('number')
          expect(record.price).to.be.a('number')
          done()
        })
        .catch(done)
  })
  it('should reject due less parameters needed in layer 1', function(done) {
    layer1
        .execute('INSERT INTO products ' + 'VALUES ($1, $2, $3)', ['Duck', 5])
        .then(function() {
          done(new Error('No error?'))
        })
        .catch(function(error) {
          expect(error.message.indexOf('more parameters') !== -1).to.equal(true)
          done()
        })
        .catch(done)
  })
  it('should reject due parameters typo in layer 1', function(done) {
    layer1
        .execute(
            'INSERT INTO products ' + 'VALUES (@product_no, @name, @price)',
            {
              name: 'Duck',
              product_n: 5,
              price: 0.99
            }
        )
        .then(function() {
          done(new Error('No error?'))
        })
        .catch(function(error) {
          expect(
              error.precedingErrors[0].message.indexOf(
                  'Must declare the scalar variable'
              ) !== -1
          ).to.equal(true)
          done()
        })
        .catch(done)
  })
  it('should not reject due extra parameters in statement in layer 1', function(done) {
    layer1
        .execute('INSERT INTO products ' + 'VALUES (8, \'Avocado\', 0.99)', {
          name: 'Duck',
          product_n: 5,
          price: 0.99
        })
        .then(function() {
          done()
        })
        .catch(done)
  })
  it('should create a table in layer 2', function(done) {
    layer2
        .execute(
            'CREATE TABLE products ( ' +
          'product_no integer, ' +
          'name varchar(10), ' +
          'price numeric(12, 2),' +
          'lastSale date,' +
          'createdAt datetimeoffset,' +
          'updatedAt datetime2)'
        )
        .then(function(res) {
          expect(res).to.be.a('array')
          expect(res.length).to.equal(0)
          done()
        })
        .catch(done)
  })
  const now = new Date()
  it('should insert date and time', function(done) {
    layer2
        .execute('INSERT INTO products ' + 'VALUES ($1, $2, $3, $4, $5, $6)', [
          1,
          'Cheese',
          59.99,
          now.toISOString().substr(0, 10),
          now,
          now
        ])
        .then(function() {
          return layer2.execute(
              'INSERT INTO products ' + 'VALUES ($1, $2, $3, $4, $5, $6)',
              [
                2,
                'Pasta',
                49.99,
                '2014-12-31',
                {value: '2014-12-31T00:00:00Z', type: 'datetime', timezone: true},
                {
                  value: '2014-12-31T00:00:00Z',
                  type: 'datetime'
                }
              ]
          )
        })
        .then(function() {
          return layer2.execute(
              'INSERT INTO products ' + 'VALUES ($1, $2, $3, $4, $5, $6)',
              [
                2,
                'Pasta',
                49.99,
                '2015-01-01',
                '2015-01-01T00:00:00-01:00',
                new Date('2014-12-31T23:00:00Z')
              ]
          )
        })
        .then(function() {
          return layer2.execute(
              'INSERT INTO products ' + 'VALUES ($1, $2, $3, $4, $5, $6)',
              [
                2,
                'Pasta',
                49.99,
                '2015-01-02',
                '2015-01-01T00:00:00+01:00',
                new Date('2015-01-01T01:00:00Z')
              ]
          )
        })
        .then(function() {
          return layer2.execute(
              'INSERT INTO products ' + 'VALUES ($1, $2, $3, $4, $5, $6)',
              [
                2,
                'Pasta',
                49.99,
                '2015-01-03',
                '2015-01-01T00:00:00+02:00',
                new Date('2015-01-01T02:00:00Z')
              ]
          )
        })
        .then(function() {
          return layer2.execute(
              'INSERT INTO products ' + 'VALUES ($1, $2, $3, $4, $5, $6)',
              [
                2,
                'Pasta',
                49.99,
                '2015-01-04',
                '2015-01-01T00:00:00-02:00',
                new Date('2014-12-31T22:00:00Z')
              ]
          )
        })
        .then(function(res) {
          expect(res).to.be.a('array')
          expect(res.length).to.equal(0)
          done()
        })
        .catch(done)
  })
  it('lets check the data', function(done) {
    layer2
        .query('SELECT * FROM products ORDER BY lastSale')
        .then(function(recordset) {
          expect(recordset).to.be.a('array')
          expect(recordset.length).to.equal(6)
          let record = recordset[0]
          expect(record.lastSale).to.be.a('Date')
          expect(record.createdAt).to.be.a('Date')
          expect(record.updatedAt).to.be.a('Date')
          expect(record.lastSale.toISOString().substr(0, 10)).to.equal(
              '2014-12-31'
          )
          expect(record.createdAt.toISOString()).to.equal(
              '2014-12-31T00:00:00.000Z'
          )
          expect(record.updatedAt.toISOString()).to.equal(
              new Date('2014-12-31T00:00:00Z').toISOString()
          )
          record = recordset[1]
          expect(record.lastSale.toISOString().substr(0, 10)).to.equal(
              '2015-01-01'
          )
          expect(record.createdAt.toISOString()).to.equal(
              '2015-01-01T01:00:00.000Z'
          )
          expect(record.updatedAt.toISOString()).to.equal(
              new Date('2014-12-31T23:00:00Z').toISOString()
          )
          record = recordset[2]
          expect(record.lastSale.toISOString().substr(0, 10)).to.equal(
              '2015-01-02'
          )
          expect(record.createdAt.toISOString()).to.equal(
              '2014-12-31T23:00:00.000Z'
          )
          expect(record.updatedAt.toISOString()).to.equal(
              new Date('2015-01-01T01:00:00Z').toISOString()
          )
          record = recordset[3]
          expect(record.lastSale.toISOString().substr(0, 10)).to.equal(
              '2015-01-03'
          )
          expect(record.createdAt.toISOString()).to.equal(
              '2014-12-31T22:00:00.000Z'
          )
          expect(record.updatedAt.toISOString()).to.equal(
              new Date('2015-01-01T02:00:00Z').toISOString()
          )
          record = recordset[4]
          expect(record.lastSale.toISOString().substr(0, 10)).to.equal(
              '2015-01-04'
          )
          expect(record.createdAt.toISOString()).to.equal(
              '2015-01-01T02:00:00.000Z'
          )
          expect(record.updatedAt.toISOString()).to.equal(
              new Date('2014-12-31T22:00:00Z').toISOString()
          )
          record = recordset[5]
          expect(record.lastSale.toISOString().substr(0, 10)).to.equal(
              now.toISOString().substr(0, 10)
          )
          expect(record.createdAt.toISOString()).to.equal(now.toISOString())
          expect(record.updatedAt.toISOString()).to.equal(now.toISOString())
          done()
        })
        .catch(done)
  })
  it('lets check the numeric value', function(done) {
    layer2
        .query('SELECT * FROM products ORDER BY lastSale')
        .then(function(recordset) {
          expect(recordset).to.be.a('array')
          expect(recordset.length).to.equal(6)
          const record = recordset[5]
          expect(Number(record.price)).to.equal(59.99)
          done()
        })
        .catch(done)
  })
  it('lets check the where in a date field', function(done) {
    layer2
        .query('SELECT * FROM products WHERE lastSale >= $1 ORDER BY lastSale', [
          '2015-01-01'
        ])
        .then(function(recordset) {
          expect(recordset).to.be.a('array')
          expect(recordset.length).to.equal(5)
          const record = recordset[0]
          expect(record.lastSale.toISOString().substr(0, 10)).to.equal(
              '2015-01-01'
          )
          done()
        })
        .catch(done)
  })
  it('lets check the where in a datetime field with time zone', function(done) {
    layer2
        .query(
            'SELECT * FROM products WHERE createdAt >= $1 ORDER BY createdAt',
            ['2014-12-31T23:00:00.000Z']
        )
        .then(function(recordset) {
          expect(recordset).to.be.a('array')
          expect(recordset.length).to.equal(4)
          const record = recordset[0]
          expect(record.createdAt.toISOString()).to.equal(
              '2014-12-31T23:00:00.000Z'
          )
          done()
        })
        .catch(done)
  })
  it('lets check the where in a datetime field without time zone', function(done) {
    layer2
        .query(
            'SELECT * FROM products WHERE updatedAt >= $1 ORDER BY updatedAt',
            [new Date('2015-01-01T01:00:00Z')]
        )
        .then(function(recordset) {
          expect(recordset).to.be.a('array')
          expect(recordset.length).to.equal(3)
          const record = recordset[0]
          expect(record.updatedAt.toISOString()).to.equal(
              new Date('2015-01-01T01:00:00.000Z').toISOString()
          )
          done()
        })
        .catch(done)
  })
  it('should use the exact type in object format in layer 1', function(done) {
    layer1
        .execute(
            'INSERT INTO products ' + 'VALUES (@product_no, @name, @price)',
            {
              name: {
                value: 'Iron',
                type: 'string',
                maxLength: 10
              },
              product_no: {
                value: 6,
                type: 'integer'
              },
              price: {
                value: 0.99,
                type: 'number',
                maxLength: 12,
                decimals: 2
              }
            }
        )
        .then(function(res) {
          expect(res).to.be.a('array')
          expect(res.length).to.equal(0)
          done()
        })
        .catch(function(error) {
          done(error)
        })
  })
  it('should use the exact type in array format in layer 1', function(done) {
    layer1
        .execute('INSERT INTO products ' + 'VALUES ($1, $2, $3)', [
          {
            value: 7,
            type: 'integer'
          },
          {
            value: 'Gate',
            type: 'string',
            maxLength: 10
          },
          {
            value: 0.99,
            type: 'number',
            maxLength: 12,
            decimals: 2
          }
        ])
        .then(function(res) {
          expect(res).to.be.a('array')
          expect(res.length).to.equal(0)
          done()
        })
        .catch(function(error) {
          done(error)
        })
  })
  it('should insert null if parameter is null or undefined in layer 1', function(done) {
    layer1
        .execute(
            'UPDATE products ' + 'SET price=$1,name=$2 WHERE product_no=$3',
            [null, void 0, 6]
        )
        .then(function(res) {
          expect(res).to.be.a('array')
          expect(res.length).to.equal(0)
          done()
        })
        .catch(function(error) {
          done(error)
        })
  })
  it('lets check the if the columns are null', function(done) {
    layer1
        .query('SELECT * FROM products WHERE product_no=$1', [6])
        .then(function(recordset) {
          expect(recordset).to.be.a('array')
          expect(recordset.length).to.equal(1)
          const record = recordset[0]
          expect(record.name).to.equal(null)
          expect(record.price).to.equal(null)
          done()
        })
        .catch(done)
  })
  it('should insert null if parameter is null or undefined also in object format in layer 1', function(done) {
    layer1
        .execute(
            'UPDATE products ' + 'SET price=$1,name=$2 WHERE product_no=$3',
            [{value: null}, {}, 5]
        )
        .then(function(res) {
          expect(res).to.be.a('array')
          expect(res.length).to.equal(0)
          done()
        })
        .catch(function(error) {
          done(error)
        })
  })
  it('lets check product 5 the if the columns are null', function(done) {
    layer1
        .query('SELECT * FROM products WHERE product_no=$1', [5])
        .then(function(recordset) {
          expect(recordset).to.be.a('array')
          expect(recordset.length).to.equal(1)
          const record = recordset[0]
          expect(record.name).to.equal(null)
          expect(record.price).to.equal(null)
          done()
        })
        .catch(done)
  })
  it('should insert 0/\'\' if parameter is 0/\'\' in layer 1', function(done) {
    layer1
        .execute(
            'UPDATE products ' + 'SET price=$1,name=$2 WHERE product_no=$3',
            [0, '', 6]
        )
        .then(function(res) {
          expect(res).to.be.a('array')
          expect(res.length).to.equal(0)
          done()
        })
        .catch(function(error) {
          done(error)
        })
  })
  it('lets check the if the columns are 0/\'\'', function(done) {
    layer1
        .query('SELECT * FROM products WHERE product_no=$1', [6])
        .then(function(recordset) {
          expect(recordset).to.be.a('array')
          expect(recordset.length).to.equal(1)
          const record = recordset[0]
          expect(record.name).to.equal('')
          expect(record.price).to.equal(0)
          done()
        })
        .catch(done)
  })
  it('should insert 0/\'\' if parameter is 0/\'\' also in object format in layer 1', function(done) {
    layer1
        .execute(
            'UPDATE products ' + 'SET price=$1,name=$2 WHERE product_no=$3',
            [{value: 0}, {value: ''}, 5]
        )
        .then(function(res) {
          expect(res).to.be.a('array')
          expect(res.length).to.equal(0)
          done()
        })
        .catch(function(error) {
          done(error)
        })
  })
  it('lets check product 5 the if the columns are 0/\'\'', function(done) {
    layer1
        .query('SELECT * FROM products WHERE product_no=$1', [5])
        .then(function(recordset) {
          expect(recordset).to.be.a('array')
          expect(recordset.length).to.equal(1)
          const record = recordset[0]
          expect(record.name).to.equal('')
          expect(record.price).to.equal(0)
          done()
        })
        .catch(done)
  })
  it('check again if film exists in layer 0', function(done) {
    layer0
        .query('SELECT * FROM films')
        .then(function(recordset) {
          expect(recordset).to.be.a('array')
          expect(recordset.length).to.equal(0)
          done()
        })
        .catch(done)
  })
  it('should create the two records using commit in transaction step by step in layer 1', function(done) {
    layer1
        .beginTransaction()
        .then(function(t) {
          return layer1
              .execute(
                  'INSERT INTO products ' + 'VALUES (100, \'Cheese\', 9.99)',
                  null,
                  {transaction: t}
              )
              .then(function() {
                return layer1.execute(
                    'INSERT INTO products ' + 'VALUES (200, \'Chicken\', 19.99)',
                    null,
                    {transaction: t}
                )
              })
              .then(function() {
                return layer1.commit(t)
              })
        })
        .then(function() {
          done()
        })
        .catch(done)
  })
  it('products should have two records in layer 1', function(done) {
    layer1
        .query('SELECT * FROM products WHERE product_no >= 100')
        .then(function(recordset) {
          expect(recordset).to.be.a('array')
          expect(recordset.length).to.equal(2)
          done()
        })
        .catch(done)
  })
  it('should run the usage example', function(done) {
    config.database = databaseName[0]
    const layer = new MssqlCrLayer(config)

    layer
        .connect()
        .then(function() {
          return layer.execute(
              'CREATE TABLE products ( ' +
            'product_no integer, ' +
            'name varchar(10), ' +
            'price numeric(12,2) )'
          )
        })
        .then(function() {
          return layer.transaction(
              function(t) {
                return layer
                    .execute(
                        'INSERT INTO products VALUES (1, \'Cheese\', 9.99)',
                        null,
                        {transaction: t}
                    )
                    .then(function() {
                      return layer.execute(
                          'INSERT INTO products VALUES (2, \'Chicken\', 19.99)',
                          null,
                          {transaction: t}
                      )
                    })
                    .then(function() {
                      return layer.execute(
                          'INSERT INTO products VALUES ($1, $2, $3)',
                          [3, 'Duck', 0.99],
                          {transaction: t}
                      )
                    })
              },
              {ISOLATION_LEVEL: 'SNAPSHOT'}
          )
        })
        .then(function() {
          return layer
              .query('SELECT * FROM products WHERE product_no=@product_no', {
                product_no: {value: 1, type: 'integer'}
              }) // or just {product_no: 1}
              .then(function(recordset) {
                expect(recordset).to.be.a('array')
                expect(recordset.length).to.equal(1)
                const record = recordset[0]
                expect(record.product_no).to.equal(1)
              })
        })
        .then(function() {
          return layer.close()
        })
        .then(function() {
          done()
        })
        .catch(function(error) {
          done(error)
        })
  })
  after(function() {
    return layer0
        .close()
        .then(function() {
          return layer1.close()
        })
        .then(function() {
          return layer2.close()
        })
  })
})

after(function() {
  createDbLayer[databaseName[0]].close()
  createDbLayer[databaseName[1]].close()
  createDbLayer[databaseName[2]].close()
})
