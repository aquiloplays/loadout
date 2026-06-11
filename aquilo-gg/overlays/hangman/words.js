/*
 * Hangman word bank. Curated, family-safe, streamer-flavored.
 *
 * Rules every word must pass (enforced by selftest.mjs):
 *   - uppercase A-Z, spaces and hyphens only
 *   - at least 4 guessable letters
 *   - starts and ends with a letter
 *
 * Spaces and hyphens are pre-revealed on the board; only A-Z letters
 * are guessed. Streamers can replace or extend the bank entirely from
 * the customizer with ?words= and ?customOnly=1.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HangmanWords = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var categories = {
    games: {
      label: 'Video Games',
      words: [
        'SPEEDRUN', 'RESPAWN', 'CHECKPOINT', 'BOSS FIGHT', 'HEADSHOT',
        'CONTROLLER', 'JOYSTICK', 'ARCADE', 'CONSOLE', 'HEALTH BAR',
        'MANA POTION', 'SIDE QUEST', 'FINAL BOSS', 'GAME OVER', 'POWER UP',
        'EXTRA LIFE', 'CUTSCENE', 'OPEN WORLD', 'BATTLE ROYALE', 'SKILL TREE',
        'ACHIEVEMENT', 'MULTIPLAYER', 'SANDBOX', 'ROGUELIKE', 'PLATFORMER',
        'LAG SPIKE', 'PATCH NOTES', 'EASTER EGG', 'SPAWN POINT', 'INVENTORY',
        'CRAFTING TABLE', 'DUNGEON CRAWL', 'LOOT GOBLIN', 'QUICKSAVE',
        'PIXEL ART', 'FRAME PERFECT', 'COMBO BREAKER', 'NEW GAME PLUS',
        'RAGE QUIT', 'TUTORIAL ISLAND', 'GLASS CANNON', 'CRIT CHANCE'
      ]
    },
    stream: {
      label: 'Stream Life',
      words: [
        'BACKSEAT GAMER', 'CLIP IT', 'RAID TRAIN', 'EMOTE SPAM', 'LURKER',
        'MODERATOR', 'CHANNEL POINTS', 'GIFTED SUB', 'HYPE TRAIN', 'BITRATE',
        'DROPPED FRAMES', 'GREEN SCREEN', 'FACECAM', 'ALERT BOX', 'COPYPASTA',
        'VTUBER', 'JUST CHATTING', 'GOING LIVE', 'STARTING SOON',
        'BE RIGHT BACK', 'SUBATHON', 'DONATION GOAL', 'SHOUTOUT',
        'FOLLOW GOAL', 'MIC CHECK', 'COZY STREAM', 'VOD REVIEW',
        'CHAT BADGE', 'STREAM DECK', 'POG MOMENT', 'GG IN CHAT',
        'TOUCH GRASS', 'CHATTERBOX', 'MOD ABUSE', 'FIRST TIME CHATTER'
      ]
    },
    animals: {
      label: 'Animals',
      words: [
        'AXOLOTL', 'CAPYBARA', 'PLATYPUS', 'RACCOON', 'OCTOPUS',
        'FLAMINGO', 'HEDGEHOG', 'NARWHAL', 'PANGOLIN', 'WOMBAT',
        'IGUANA', 'CHAMELEON', 'MONGOOSE', 'ARMADILLO', 'WALRUS',
        'GECKO', 'TOUCAN', 'JELLYFISH', 'MANTIS SHRIMP', 'RED PANDA',
        'SNOW LEOPARD', 'HONEY BADGER', 'KOMODO DRAGON', 'BLUE WHALE',
        'TARDIGRADE', 'FERRET', 'ALPACA', 'MEERKAT', 'PUFFERFISH',
        'SEAHORSE', 'PELICAN', 'OSTRICH', 'PENGUIN', 'GIRAFFE', 'KANGAROO'
      ]
    },
    food: {
      label: 'Food + Snacks',
      words: [
        'QUESADILLA', 'CROISSANT', 'GUACAMOLE', 'PRETZEL', 'BURRITO',
        'LASAGNA', 'MACARONI', 'PANCAKES', 'WAFFLES', 'SUSHI ROLL',
        'HOT SAUCE', 'GARLIC BREAD', 'MOZZARELLA', 'PEPPERONI',
        'CINNAMON ROLL', 'MILKSHAKE', 'SMOOTHIE', 'AVOCADO TOAST',
        'DUMPLINGS', 'CHURROS', 'TIRAMISU', 'PISTACHIO', 'MARSHMALLOW',
        'POPCORN', 'NACHOS', 'KIMCHI', 'FALAFEL', 'GNOCCHI', 'BAGUETTE',
        'OMELETTE', 'BROWNIE', 'CUPCAKE', 'SRIRACHA', 'ENERGY DRINK',
        'RAMEN NIGHT', 'PIZZA CRUST'
      ]
    },
    screen: {
      label: 'Movies + TV',
      words: [
        'PLOT TWIST', 'JUMP SCARE', 'BLOOPERS', 'SPOILER ALERT',
        'BINGE WATCH', 'CLIFFHANGER', 'END CREDITS', 'MAIN CHARACTER',
        'VILLAIN ARC', 'ORIGIN STORY', 'BOX OFFICE', 'FILM NOIR',
        'DOCUMENTARY', 'ANIMATION', 'SOUNDTRACK', 'SCREENPLAY',
        'STUNT DOUBLE', 'RED CARPET', 'BLOCKBUSTER', 'INDIE FILM',
        'PILOT EPISODE', 'SEASON FINALE', 'CROSSOVER', 'POST CREDITS',
        'MOVIE NIGHT', 'CASTING CALL', 'TRILOGY', 'DIRECTORS CUT',
        'LASER SWORD', 'TIME TRAVEL', 'FOUND FOOTAGE', 'LAUGH TRACK'
      ]
    },
    places: {
      label: 'Places',
      words: [
        'MARRAKESH', 'PATAGONIA', 'SANTORINI', 'YELLOWSTONE',
        'GRAND CANYON', 'MACHU PICCHU', 'TIMBUKTU', 'KATHMANDU',
        'AMSTERDAM', 'BARCELONA', 'ISTANBUL', 'SINGAPORE', 'MADAGASCAR',
        'GALAPAGOS', 'STONEHENGE', 'EVEREST', 'SAHARA', 'ANTARCTICA',
        'BERMUDA', 'HAVANA', 'VENICE', 'KYOTO', 'CAIRO',
        'NIAGARA FALLS', 'MOUNT FUJI', 'DEATH VALLEY', 'EIFFEL TOWER',
        'TAJ MAHAL', 'GREAT BARRIER REEF', 'REYKJAVIK', 'OUTER BANKS',
        'LOST CITY'
      ]
    },
    tech: {
      label: 'Tech + Internet',
      words: [
        'ALGORITHM', 'BANDWIDTH', 'BLUETOOTH', 'FIREWALL', 'MAINFRAME',
        'DEBUGGING', 'ENCRYPTION', 'DOOMSCROLL', 'SCREENSHOT',
        'WIFI PASSWORD', 'AIRPLANE MODE', 'HOTSPOT', 'MOTHERBOARD',
        'OVERCLOCK', 'BENCHMARK', 'TOUCHSCREEN', 'NOTIFICATION',
        'AUTOCORRECT', 'CLICKBAIT', 'INFLUENCER', 'LIVESTREAM',
        'PODCAST', 'HASHTAG', 'USERNAME', 'BROWSER TAB', 'DARK MODE',
        'SPAM FOLDER', 'GROUP CHAT', 'MEGAPIXEL', 'SMARTWATCH',
        'BLUE SCREEN', 'CTRL ALT DELETE', 'INCOGNITO MODE', 'REPLY GUY'
      ]
    },
    sports: {
      label: 'Sports',
      words: [
        'SLAM DUNK', 'HAT TRICK', 'TOUCHDOWN', 'HOME RUN', 'KNOCKOUT',
        'MARATHON', 'SKATEBOARD', 'SNOWBOARD', 'FREE THROW',
        'PENALTY KICK', 'GRAND SLAM', 'PHOTO FINISH', 'OVERTIME',
        'UNDERDOG', 'CHAMPION', 'GOALKEEPER', 'QUARTERBACK', 'FASTBALL',
        'CURVEBALL', 'TRIATHLON', 'GYMNASTICS', 'JAVELIN', 'POLE VAULT',
        'SURFBOARD', 'HALF PIPE', 'VICTORY LAP', 'BUZZER BEATER',
        'NUTMEG', 'BICYCLE KICK', 'POWER PLAY', 'FACE OFF', 'TIEBREAKER'
      ]
    }
  };

  var keys = Object.keys(categories);

  return {
    categories: categories,
    keys: keys,
    label: function (key) {
      return categories[key] ? categories[key].label : key;
    }
  };
});
