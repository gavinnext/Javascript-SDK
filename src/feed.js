/*global define:false */

/*! A Feed.fm joint: github.com/fuzz-radio/Javascript-SDK */

/*
 * This is the object we export as 'Feed' when everything is bundled up.
 */

define([ 'feed/session', 'feed/log', 'feed/player-view', 'feed/player', 'feed/speaker' ], function(Session, log, PlayerView, Player) {

  return {
    Session: Session,
    Player: Player,
    PlayerView: PlayerView
  };

});
