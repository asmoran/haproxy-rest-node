var assert = require('assert')
  , path = require('path')
  , request = require('request')
  , async = require('async')
  , portfinder = require('portfinder')
  , Hapi = require('hapi')
  , Api = require('../lib/Api')
  , Data = require('../lib/Data')
  ;

describe ('API', function () {

  function MockHaproxyManager() {
    this.latestConfig = 'fake templated config string\n';
  }


  describe ('HTTP', function () {
    var localhost = '127.0.0.1'
      , apiPort = null
      , server = null
      , haproxyManager = null
      , apiRoot = null
      ;

    before (function (done) {

      portfinder.basePort = Math.ceil(Math.random()*2000)+10000;
      portfinder.getPort(function (err, port1) {
        // TODO: guarantee free ports, portfinder wasn't working right but this hack was better for now
        var port2 = port1+1, port3 = port1+2;
        assert.ifError(err);

        apiPort = port3;
        apiRoot = 'http://' + localhost + ':' + apiPort;
        server = new Hapi.Server();
        server.connection({
		port: apiPort,
		host: localhost
	});
        haproxyManager = new MockHaproxyManager();
        server.route( (new Api({ data: new Data(), haproxyManager: haproxyManager })).routes() );
        server.start(done);
      });
    });

    after (function () {
      server.stop();
    });


    it ('should put and get and delete frontend', function (done) {
      var fe = { key: 'foo', bind: '*:80', backend: 'foob' };

      // need to wait until it comes up
      setTimeout(function () {
        request({
          method: 'PUT',
          uri: apiRoot + '/frontends/' + fe.key,
          json: fe
        }, function (error, response, body) {
          assert.ifError(error);
          assert.equal(200, response.statusCode);

          request({
            method: 'GET',
            uri: apiRoot + '/frontends/' + fe.key,
            json: true
          }, function (error, response, body) {
            assert.ifError(error);
            assert.equal(200, response.statusCode);

            assert(body);
            assert.equal(fe.key, body.key);
            assert.equal(fe.bind, body.bind);
            assert.equal(fe.backend, body.backend);

            request({
              method: 'DELETE',
              uri: apiRoot + '/frontends/' + fe.key,
              json: true
            }, function (error, response, body) {
              assert.ifError(error);
              assert.equal(200, response.statusCode);

              request({
                method: 'GET',
                uri: apiRoot + '/frontends/' + fe.key,
                json: true
              }, function (error, response, body) {
                assert.ifError(error);
                assert.equal(404, response.statusCode);
                done();
              });
            });

          });
        });
      }, 50);
    });

    it ('should put and get and delete backendend', function (done) {
      var be = { key: 'foo', name: 'foo', version: '1.0.0', type: 'dynamic' };

      // need to wait until it comes up
      setTimeout(function () {
        request({
          method: 'PUT',
          uri: apiRoot + '/backends/' + be.key,
          json: be
        }, function (error, response, body) {
          assert.ifError(error);
          assert.equal(200, response.statusCode);

          request({
            method: 'GET',
            uri: apiRoot + '/backends/' + be.key,
            json: true
          }, function (error, response, body) {
            assert.ifError(error);
            assert.equal(200, response.statusCode);

            assert(body);
            assert.equal(be.key, body.key);
            assert.equal(be.name, body.name);
            assert.equal(be.version, body.version);
            assert.equal(be.type, body.type);

            request({
              method: 'DELETE',
              uri: apiRoot + '/backends/' + be.key,
              json: true
            }, function (error, response, body) {
              assert.ifError(error);
              assert.equal(200, response.statusCode);

              request({
                method: 'GET',
                uri: apiRoot + '/backends/' + be.key,
                json: true
              }, function (error, response, body) {
                assert.ifError(error);
                assert.equal(404, response.statusCode);
                done();
              });
            });

          });
        });
      }, 50);
    });

    it ('should require host with health.httpVersion HTTP/1.1', function (done) {
      var health = { uri:'/checkity-check', httpVersion:'HTTP/1.1' };
      var be = { key: 'healthy', name: 'foo', version: '1.0.0', type: 'dynamic', health: health };

      // need to wait until it comes up
      setTimeout(function () {
        request({
          method: 'PUT',
          uri: apiRoot + '/backends/' + be.key,
          json: be
        }, function (error, response, body) {
          assert.ifError(error);
          assert.equal(400, response.statusCode);

          be.host = 'foo.com';

          request({
            method: 'PUT',
            uri: apiRoot + '/backends/' + be.key,
            json: be
          }, function (error, response, body) {
            assert.ifError(error);
            assert.equal(200, response.statusCode);
            done();
          });
        });
      }, 50);
    });

    it ('should get all frontends and backends', function (done) {
      var fe1 = { key: 'fe1', bind: '*:80', backend: 'be1' };
      var fe2 = { key: 'fe2', bind: '*:81', backend: 'be1' };
      var be1 = { key: 'be1', type: 'static', members: [{ host: '10.10.10.10', port: '80' },
                                                         { host: '10.10.10.20', port: '81' }]};
      var be2 = { key: 'be2', type: 'static', members: [{ host: '10.10.20.10', port: '90' },
                                                         { host: '10.10.20.20', port: '91' }]};

      function put (uri, obj, next) {
        request({
          method: 'PUT',
          uri: apiRoot + uri,
          json: obj
        }, function (error, response, body) {
          assert.ifError(error);
          assert.equal(200, response.statusCode);
          next();
        });
      }

      async.series([
        function (next) { put ('/frontends/' + fe1.key, fe1, next); },
        function (next) { put ('/frontends/' + fe2.key, fe2, next); },
        function (next) { put ('/backends/' + be1.key, be1, next); },
        function (next) { put ('/backends/' + be2.key, be2, next); },
        function (next) {
          request({
            uri: apiRoot + '/frontends',
            json: true
          }, function (error, response, body) {
            assert.ifError(error);
            assert.equal(200, response.statusCode);
            assert(Array.isArray(body));
            assert(body.filter(function (fe) { return fe.backend === 'be1';}).length, 2);
            next();
          });
        },
        function (next) {
          request({
            uri: apiRoot + '/backends',
            json: true
          }, function (error, response, body) {
            assert.ifError(error);
            assert.equal(200, response.statusCode);
            assert(Array.isArray(body));
            assert(body.filter(function (be) { return be.key === 'be1' || be.key === 'be2'; }).length, 2);
            next();
          });
        },
        function (next) {
          request({
            uri: apiRoot + '/backends/'+be1.key+'/members',
            json: true
          }, function (error, response, body) {
            assert.ifError(error);
            assert.equal(200, response.statusCode);
            assert(Array.isArray(body));
            assert(body.length, 2);
            assert.deepEqual(body, be1.members);
            next();
          });
        },
        function (next) {
          request({
            uri: apiRoot + '/backends/doesnotexist/members',
            json: true
          }, function (error, response, body) {
            assert.ifError(error);
            assert.equal(404, response.statusCode);
            next();
          });
        }
      ],
      function () {
        done();
      });
    });

    it ('should get latest haproxy config', function (done) {
      request({
        uri: apiRoot + '/haproxy/config',
        json: true
      }, function (error, response, body) {
        assert.ifError(error);
        assert.equal(200, response.statusCode);
        assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(body, haproxyManager.latestConfig);
        done();
      });
    });
  });
});
