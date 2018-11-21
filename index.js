const Discord = require('discord.js');
const Config = require('./config');
const CronJob = require('cron').CronJob;
const fs = require('promise-fs');
const express = require('express');
const EloRating = require('elo-rating');
const process = require('process');
const _ = require('lodash');

let scoreKeys = [];
// make sure to update dump/load funcs if adding new stuff in here
const state = {
  scores: new Map(),
  ignored: new Map(),
  lastMessage: undefined
};

function isValidMessage(message) {
  const content = message.cleanContent;

  const words = content.split(' ').length;
  if (words > 4 || content.length == 0) {
    return false;
  }

  if (content.indexOf('http') === -1) {
    return false;
  }

  return true;
}

async function grabAndDumpLogs() {
  const client = new Discord.Client();

  client.on('ready', async () => {
    const channel = client.channels.get(Config.channel);

    let oldestMessage = undefined;
    let localLastMessage = undefined;
    let totalMessages = 0;

    while (true) {
      let messages;
      if (state.lastMessage !== undefined) {
        messages = await channel.fetchMessages({ limit: 100, after: state.lastMessage });
      } else {
        messages = await channel.fetchMessages({ limit: 100, before: oldestMessage });
      }
      
      if (messages.size === 0) {
        break;
      } else {
        oldestMessage = messages.last().id;
        if (localLastMessage === undefined) {
          localLastMessage = messages.first().id;
        }
      }

      for (let message of messages) {
        if (state.scores.has(message[0])) {
          continue;
        }

        if (!isValidMessage(message[1])) {
          continue;
        }

        const scoreObj = {id: message[1].id, name: message[1].cleanContent, author: message[1].author.username, link: message[1].url, score: 1500}
        state.scores.set(message[0], scoreObj)
      }

      totalMessages += messages.size;
      console.log(`downloaded messages ${totalMessages}`);

      if (messages.size < 100) {
        break;
      }
    }

    if (localLastMessage !== undefined) {
      state.lastMessage = localLastMessage;
    }
    
    dumpState(Config.dataFile, state);
    scoreKeys = [...state.scores.keys()];
    client.destroy();
  });

  client.login(Config.token);
}

async function dumpState(path, state, sync=false) {
  console.log("dumping scores to disk");
  const dumpObj = {scores: [...state.scores], ignored: [...state.ignored], lastMessage: state.lastMessage};
  if (sync) {
    fs.writeFileSync(path, JSON.stringify(dumpObj));
  } else {
    await fs.writeFile(path, JSON.stringify(dumpObj));
  }
  console.log("wrote state to disk");
}

async function loadState(path) {
  try {
    const str = await fs.readFile(path);
    const obj = JSON.parse(str);
    state.scores = new Map(obj.scores);
    state.ignored = new Map(obj.ignored);
    state.lastMessage = obj.lastMessage;
    scoreKeys = [...state.scores.keys()];
    console.log("loaded state from disk");
  } catch (e) {
    console.log("Couldn't load saved state, starting from scratch", e);
  }
}

function getRandomMatch() {
  return {
    first: state.scores.get(scoreKeys[Math.floor(Math.random() * scoreKeys.length)]),
    second: state.scores.get(scoreKeys[Math.floor(Math.random() * scoreKeys.length)])
  };
}

function getBestQuotes(number=10) {
  const top = [...state.scores.values()].sort((a, b) => b.score - a.score);
  return top.slice(0, number);
}

function getBestAuthors(number=100) {
  const values = [...state.scores.values()];
  const byAuthor = _.groupBy(values, 'author');
  const stats = _.mapValues(byAuthor, items => { return {'avg': _.meanBy(items, 'score'), 'total': items.length} } );
  _.forEach(stats, (value, key) => value.author = key)
  const sortedStats = _.sortBy(stats, 'avg').reverse()
  return sortedStats.slice(0, number);
}

async function main() {
  await loadState(Config.dataFile);
  await grabAndDumpLogs();

  process.on('SIGINT', (code) => {
    console.log('caught sigint, writing state to disk');
    dumpState(Config.dataFile, state, sync=true);
    process.exit()
  });

  new CronJob({
    cronTime: '0 */1 * * *',
    onTick: grabAndDumpLogs,
    start: true,
    runOnInit: false
  });

  new CronJob({
    cronTime: '*/5 * * * *',
    onTick: () => dumpState(Config.dataFile, state),
    start: true,
    runOnInit: false
  });

  const app = express();
  app.use(express.json());
  app.use(express.static('public'))

  app.get('/match', (req, res) => {
    res.type('application/json');
    res.send(JSON.stringify({match: getRandomMatch()}));
  });

  app.get('/top', (req, res) => {
    res.type('application/json');
    const top = getBestQuotes();
    const authors = getBestAuthors();
    res.send(JSON.stringify({top, authors}));
  });

  app.post('/vote', (req, res) => {   
    res.type('application/json');

    const winner = state.scores.get(req.body.winner);
    const loser = state.scores.get(req.body.loser);
    if (winner === undefined || loser === undefined) {
      res.send(JSON.stringify({
        match: getRandomMatch(),
      }));

      return;
    }

    const results = EloRating.calculate(winner.score, loser.score, true);
    winner.score = results.playerRating;
    loser.score = results.opponentRating;

    res.send(JSON.stringify({
      match: getRandomMatch(),
      results: {first: winner, second: loser}
    }));
  });

  app.listen(Config.port, () => console.log(`Web server listening on port ${Config.port}`));
}

main();