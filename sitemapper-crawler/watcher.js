var DDPClient = require('ddp');
var _ = require('underscore');
var logger = require('tracer').colorConsole({
  format : "{{timestamp}} <{{title}}> [Watcher] {{message}}",
  dateformat : "HH:MM:ss.l"
});

var Watcher = function (postal) {
  var watcher = this;
  watcher.postal = postal;

  watcher.queue = [];
  watcher.pushLimit = 30;
  watcher.publishPageInterval = 5;
  watcher.ddpclient = new DDPClient({
    host: "localhost",
    port: 3000,
    auto_reconnect: true,
    auto_reconnect_timer: 500,
    use_ejson: true,
    use_ssl: false,
    maintain_collections: true
  });

  watcher.subscribe();
  watcher.start();
};

Watcher.prototype.start = function () {
  var watcher = this;

  watcher.ddpclient.connect(function(error) {
    if (error) {
      logger.error('DDP connection error!');
      return;
    }

    // Subscribe does set up a data object for maintence but since mapper is the one that
    // cares most about that object. I maintain it by pushing data into mapper using the message
    // function below.
    watcher.ddpclient.subscribe('unscannedSites', [], function () {});
    logger.info('Connected to meteor');
  });

  // Queue watcher
  watcher.interval = setInterval(watcher.processPageQueue, 1000 * watcher.publishPageInterval, watcher); // Every 30 seconds
};

Watcher.prototype.subscribe = function () {
  var watcher = this;

  watcher.postal.subscribe({
    channel: 'Sites',
    topic:   'updated',
    callback: watcher.updateSiteStatus
  }).withContext(watcher);

  watcher.postal.subscribe({
    channel: 'Pages',
    topic:   'crawled',
    callback: watcher.push
  }).withContext(watcher);

  watcher.postal.subscribe({
    channel: 'Sites',
    topic: 'readyforlinking',
    callback: watcher.requestPages
  }).withContext(watcher);

  watcher.ddpclient.on('message', function (msg) {
    var message = JSON.parse(msg);
    // logger.warn(msg);

    if (message.msg === 'added' && message.collection === 'sitescans') {
      // Munging to get in right format
      var site = {};
      site._id = message.id;
      _.extend(site, message.fields);

      // Put onto the stack
      watcher.postal.publish({
          channel: 'Sites',
          topic: 'added',
          data: site
      });
    }

  });
};

Watcher.prototype.requestPages = function (sitescan_id) {
  var watcher = this;

  watcher.ddpclient.call('findUnlinkedPages', [sitescan_id],
      function (err, result) {
        console.log('called function, result: ' + result);
          watcher.postal.publish({
              channel: 'Sites',
              topic: 'pagesforlinking',
              data: result
          });
      });
};

Watcher.prototype.processPageQueue = function (self) {
  var watcher = self;
  logger.log('Pages scanned to publish %s.', watcher.queue.length);

  // Work through the list
  for (var i = watcher.pushLimit; i >= 0; i--) {
    // Bail if there's nothing here.
    if (watcher.queue.length === 0) return;
    var next = watcher.next();
    watcher.publishPage(next);
  }
};

Watcher.prototype.publishPage = function (page) {
  var watcher = this;
  var ddpclient = watcher.ddpclient;

  watcher.ddpclient.call('pushPage', [page],
    function (err, result) {
      if (err) {
        logger.error(err);
        return;
      }
      // logger.info('Successfully inserted: ' + result);
    },
    function () { // callback which fires when server has finished
      // console.log('updated');
    }
  );
};

// Queues a page to be published
// Lets maintain a sorted array of objects so I can merge things in
// as needed
Watcher.prototype.push = function (data) {
  // Nothing to do
  if (this.queue.length === 0) {
    this.queue.push(data);
    return this.queue.length;
  }

  // Let's see if we can find another item in the queue
  var itemInQueue = _.find(this.queue, function (element) {
    if (element.url === data.url && element.sitescan_id === data.sitescan_id) {
      return true;
    } else {
      return false;
    }
  }, this);

  // Insert into the queue because there's nothing in there
  if (itemInQueue === undefined) {
    this.queue.push(data);
    return this.queue.length;
  }

  // Go through and merge it in
  _.each(this.queue, function (element, index, list) {
    if (element.url === data.url && element.sitescan_id === data.sitescan_id) {
      list[index] = _.extend(data, element);
    }
  }, this);

  return this.queue.length;
};

// Returns next in the queue line
Watcher.prototype.next = function () {
  return this.queue.shift();
};

/**
 * This pushes data into meteor with a simple site variable
 * meteor will upsert any data contained in the site object
 * except the _id, URL, and created_at params.
 * @param  {[type]} site Simple site object
 * @return {[type]}      [description]
 */
Watcher.prototype.updateSiteStatus = function (site) {
  var watcher = this;
  var ddpclient = watcher.ddpclient;

  ddpclient.call('updateSiteStatus', [site],
    function (err, result) {
      if (err) {
        logger.error(err);
        return;
      }
      logger.log('Successfully updated status of ' + result);
    },
    function () { // CB that fires when server is finished
      // do nothing for now
    }
  );
};

module.exports = Watcher;