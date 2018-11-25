const Discord = require('discord.js');
const Config = require('./config');
const CronJob = require('cron').CronJob;
const fs = require('promise-fs');
const express = require('express');
const EloRating = require('elo-rating');
const process = require('process');
const _ = require('lodash');
const handlebars = require('handlebars');

let scoreKeys = [];
// make sure to update dump/load funcs if adding new stuff in here
const state = {
  scores: new Map(),
  ignored: new Map(),
  lastMessage: undefined
};

function isValidName(content) {
  const words = content.split(' ').length;
  // star wars names seem to never go past 4 words, or if empty
  if (words > 4 || content.length == 0) {
    return false;
  }

  // basic substring check
  const bad = ['http', '@', '<', '^'];
  for (let str of bad) {
    if (content.indexOf(str) !== -1) {
      return false;
    }
  }

  // don't even bother with 1 word lowercase since it's probably us laughing
  if (content[0].toLowerCase() === content[0] && words === 1) {
    return false;
  }

  return true;
}

// put the message into ignored for moderation queue purposes
function isDefaultIgnoredName(content) {
  // if the first letter is lowercase (and it's a valid name) it might be valid
  if (content[0].toLowerCase() === content[0]) {
    return true;
  }

  return false;
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

        if (state.ignored.has(message[0])) {
          continue;
        }

        if (!isValidName(message[1].cleanContent)) {
          continue;
        }

        const scoreObj = {id: message[1].id, name: message[1].cleanContent, author: message[1].author.username, link: message[1].url, score: 1500, wins: 0, losses: 0}
        
        if (isDefaultIgnoredName(message[1].cleanContent)) {
          state.ignored.set(message[0], scoreObj);
        } else {
          state.scores.set(message[0], scoreObj);
        }
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

    for (let key of state.scores.keys()) {
      if (!isValidName(state.scores.get(key).name)) {
        state.scores.delete(key);
      }
    }

    state.ignored = new Map(obj.ignored);
    state.lastMessage = obj.lastMessage;
    scoreKeys = [...state.scores.keys()];
    console.log("loaded state from disk");
  } catch (e) {
    console.log("Couldn't load saved state, starting from scratch", e);
  }
}

function getRandomName() {
  return state.scores.get(scoreKeys[Math.floor(Math.random() * scoreKeys.length)]);
}

function getRandomMatch() {
  return {
    first: getRandomName(),
    second: getRandomName()
  };
}

function getCloseMatch() {
  const first = getRandomName();
  const score = first.score;
  const delta = 25;
  const contenders = _.filter([...state.scores.values()], name => name.score >= score - delta && name.score <= score + delta && name.id !== first.id);

  if (!contenders.length) {
    return getRandomMatch();
  }

  const keys = contenders.keys();

  return {
    first,
    second: contenders[Math.floor(Math.random() * contenders.length)]
  };

}

function getBestQuotes(number=10) {
  const top = [...state.scores.values()].sort((a, b) => b.score - a.score);
  return top.slice(0, number);
}

function getBestAuthors(number=100) {
  const values = [...state.scores.values()];
  const byAuthor = _.groupBy(values, 'author');
  const stats = _.mapValues(byAuthor, items => {
    const wins = _.sumBy(items, 'wins');
    const losses = _.sumBy(items, 'losses');
    const ratio = (wins / losses).toFixed(1);
    return {wins, losses, ratio, 'total': items.length}
  });

  _.forEach(stats, (value, key) => value.author = key)
  const sortedStats = _.sortBy(stats, 'ratio').reverse();
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
  
  app.get('/', async (req, res) => {
    const top = getBestQuotes();
    const authors = getBestAuthors();

    const src = await fs.readFile('./vote.handlebars');
    const template = handlebars.compile(src.toString());
    res.send(template({top, authors}));
  });

  app.get('/all', async (req, res) => {
    const top = getBestQuotes(state.scores.size);

    const src = await fs.readFile('./all.handlebars');
    const template = handlebars.compile(src.toString());
    res.send(template({top, ignored: [...state.ignored.values()]}));
  });

  app.get('/match', (req, res) => {
    res.type('application/json');
    res.send(JSON.stringify({match: getCloseMatch()}));
  });

  app.post('/ignore', (req, res) => {
    res.type('application/json');

    const id = req.body.id;
    const ignore = req.body.ignore;

    if (ignore === true) {
      const name = state.scores.get(id);
      if (name) {
        state.ignored.set(id, name);
        state.scores.delete(id);
        scoreKeys = [...state.scores.keys()];
        res.send(JSON.stringify({success: true}));
        return;
      }
    } else if (ignore === false) {
      const name = state.ignored.get(id);
      if (name) {
        state.scores.set(id, name);
        state.ignored.delete(id);
        scoreKeys = [...state.scores.keys()];
        res.send(JSON.stringify({success: true}));
        return;
      }
    }

    res.send(JSON.stringify({success: false}));
  });

  app.post('/vote', (req, res) => {   
    res.type('application/json');

    const winner = state.scores.get(req.body.winner);
    const loser = state.scores.get(req.body.loser);
    if (winner === undefined || loser === undefined) {
      res.send(JSON.stringify({
        match: getCloseMatch(),
      }));

      return;
    }

    const results = EloRating.calculate(winner.score, loser.score, true);
    winner.score = results.playerRating;
    loser.score = results.opponentRating;

    winner.wins += 1;
    loser.losses += 1;

    res.send(JSON.stringify({
      match: getCloseMatch(),
      results: {first: winner, second: loser}
    }));
  });

  app.listen(Config.port, () => console.log(`Web server listening on port ${Config.port}`));
}

main();