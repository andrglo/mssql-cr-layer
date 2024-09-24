# mssql-cr-layer [![NPM version][npm-image]][npm-url] [![Dependency Status][daviddm-image]][daviddm-url] [![CircleCI](https://circleci.com/gh/andrglo/mssql-cr-layer.svg?style=svg)](https://circleci.com/gh/andrglo/mssql-cr-layer) (https://coveralls.io/repos/github/andrglo/mssql-cr-layer/badge.svg?branch=master)](https://coveralls.io/github/andrglo/mssql-cr-layer?branch=master)

> A MS SQL Server interface layer for common requests. It uses [mssql](https://github.com/patriksimek/node-mssql) to connect
and wraps it in a tiny layer using ES2015 promises with the goal to be simpler and compatible with [pg](https://github.com/brianc/node-postgres)
via [pg-cr-layer](https://github.com/andrglo/pg-cr-layer)



## Install

```sh
$ npm install --save mssql-cr-layer
```


## Usage

```js
var mssqlCrLayer = require('mssql-cr-layer');

var config = {
  user: 'me',
  password: 'my password',
  host: 'localhost',
  port: 1433,
  pool: {
    max: 25,
    idleTimeout: 30000
  }
};

var layer = new MssqlCrLayer(config)

layer.connect()
  .then(function() {
    return layer.execute('CREATE TABLE products ( ' +
      'product_no integer, ' +
      'name varchar(10), ' +
      'price numeric(12,2) )');
  })
  .then(function() {
    return layer.transaction(function(t) {
      return layer
	      .execute('INSERT INTO products VALUES (1, \'Cheese\', 9.99)', null, {transaction: t})
          .then(function() {
            return layer.execute('INSERT INTO products VALUES (2, \'Chicken\', 19.99)', null, {transaction: t})
          })
		  .then(function() {
        return layer
          .execute('INSERT INTO products VALUES ($1, $2, $3)', [3, 'Duck', 0.99], {transaction: t})
       });
     })
  })
  .then(function() {
    return layer.query('SELECT * FROM products WHERE product_no=@product_no',
      {product_no: {value: 1, type: 'integer'}}) // or just {product_no: 1}
    .then(function(recordset) {
      console.log(recordset[0]); // => { product_no: 1, name: 'Cheese', price: 9.99 }
    })
  })
  .then(function() {
    return layer.close();
  })
  .catch(function(error) {
	  console.log(error);
  });

```

## License

MIT © [Andre Gloria](andrglo.com)


[npm-image]: https://badge.fury.io/js/mssql-cr-layer.svg
[npm-url]: https://npmjs.org/package/mssql-cr-layer
[daviddm-image]: https://david-dm.org/andrglo/mssql-cr-layer.svg?theme=shields.io
[daviddm-url]: https://david-dm.org/andrglo/mssql-cr-layer
