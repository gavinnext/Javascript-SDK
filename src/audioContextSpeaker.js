/*
 * The speaker object uses native web audio, and the interface boils it down
 * to the following api:
 *
 *    speaker.initializeAudio(): many clients can only start using
 *      audio when handling an 'onClick' event. This call should be made
 *      at that time to get audio initialized while waiting for details
 *      of what to play from the server.
 *
 *    speaker.setVolume(value): set the volume from 0 (mute) - 100 (full volume)
 *
 *    var sound = speaker.create(url, optionsAndEvents): create a new sound from the
 *       given url and return a 'song' object that can be used to pause/play/
 *       destroy the song and receive trigger events as the song plays/stops.
 *
 *       The 'optionsAndEvents' is an object that lets you specify event
 *       handlers and options:
 *
 *          startPosition:  specifies the time offset (in milliseconds) that the
 *                          sound should begin playback at when we begin playback.
 *          endPosition:    specifies the time offset (in milliseconds) that the
 *                          sound should stop playback
 *          fadeInSeconds:  # of seconds to fade in audio
 *          fadeOutSeconds: # of seconds to fade out audio
 *          play:           event handler for 'play' event
 *          pause:          event handler for 'pause' event
 *          finish:         event handler for 'finish' event
 *          elapse:         event handler for 'elapse' event
 *
 *       The returned object emits the following events:
 *         play: the song has started playing or resumed playing after pause
 *         pause: the song has paused playback
 *         finish: the song has completed playback and the song object
 *           is no longer usable and should be destroyed
 *         elapse: song playback has elapsed
 *
 *       The events should be received in this order only:
 *         ( play -> ( pause | play )* -> )? finish
 *
 *       Note that I represent play failures as a 'finish' call, so if
 *       we can't load a song, it will just get a 'finish' and no 'play'.
 *       The 'finish' event will have a 'true' argument passed to it on
 *       some kind of error, so you can treat those differently.
 *
 *       The returned song object has this following api:
 *         play: start playback (at the 'startPosition', if specified)
 *         pause: pause playback
 *         resume: resume playback
 *         destroy: stop playback, prevent any future playback, and free up memory
 *
 *   The speaker assumes that you'll be playing only one sound at a time. When
 *   you kick off playback of a sound, it stops playback of any existing sound.
 *   Fade-outs are handled by reporting the audio as complete when the fade-out
 *   begins, but the sound continues playback until it has fully faded out. New
 *   audio can be started while the fadeout is happening.
 */

import log from "./log";
import Events from "./events";
import { uniqueId } from "./util";
import Sound from "./sound";

class AudioPlayer {
  constructor({ url, buffer, context, source }) {
    Object.assign(this, Events);
    this.src = url;
    this.buffer = buffer;
    this.context = context;
    this.source = source;
    this.paused = true;
    this.currentTime = context.currentTime;
    this.duration = buffer.duration;
    this.buffered = "";
  }

  pollTime() {
    this.interval = setInterval(() => {
      this.currentTime = this.context.currentTime;
      this.trigger("ontimeupdate");
    }, 1000);
  }

  play() {
    console.log("pressing play");
    this.paused = false;

    if (this.context.state === "suspended") {
      this.pollTime();
      return this.context.resume();
    }

    this.source.start(0);
    this.pollTime();

    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    clearInterval(this.interval);
    return this.context?.suspend();
  }
}

const DEFAULT_VOLUME = 1.0;

const iOSp = /(iPhone|iPad)/i.test(navigator.userAgent);
const brokenWebkit = iOSp && /OS 13_[543210]/i.test(navigator.userAgent);

const SILENCE = iOSp
  ? "https://u9e9h7z5.map2.ssl.hwcdn.net/feedfm-audio/250-milliseconds-of-silence.mp3"
  : "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

//const SILENCE = 'https://dgase5ckewowv.cloudfront.net/feedfm-audio/1573592316-88123.m4a';

function d(audio) {
  return (
    " src = " +
    audio.src +
    ", time = " +
    audio.currentTime +
    ", paused = " +
    audio.paused +
    ", duration = " +
    audio.duration +
    ", readyState = " +
    audio.readyState
  );
}

Sound.prototype = {
  play: function () {
    log("sound " + this.id + " play");
    return this.speaker._playSound(this);
  },

  // pause playback of the current sound clip
  pause: function () {
    log("sound " + this.id + " pause");
    return this.speaker._pauseSound(this);
  },

  // resume playback of the current sound clip
  resume: function () {
    log("sound " + this.id + " resume");
    return this.speaker._playSound(this);
  },

  // elapsed number of milliseconds played
  position: function () {
    //log(this.id + ' sound position');
    return this.speaker._position(this);
  },

  // duration in milliseconds of the song
  // (this may change until the song is full loaded)
  duration: function () {
    //log(this.id + ' sound duration');
    return this.speaker._duration(this);
  },

  // stop playing the given sound clip, unload it, and disable events
  // note that no further events will be sent from this sound
  // (so no 'finish' event, in particular)
  destroy: function () {
    log("sound " + this.id + " destroy");
    this.speaker._destroySound(this);
  },

  gainAdjustedVolume: function (volume) {
    if (!this.gain) {
      return volume / 100;
    }

    var adjusted =
      Math.max(
        Math.min((volume / 100) * (50 * Math.pow(10, this.gain / 20)), 100),
        0
      ) / 100;

    //log('gain adjustment is ' + this.gain + ', and final adjusted volume is ' + adjusted);

    return adjusted;
  },
};

let Speaker = function () {};

// exports with this version of Javacript isn't working, so...
Speaker.iOSp = iOSp;
Speaker.brokenWebkit = brokenWebkit;

function createAudioContext() {
  var AudioCtor = window.AudioContext || window.webkitAudioContext;

  let desiredSampleRate = 44100;
  var context = new AudioCtor();

  // Check if hack is necessary. Only occurs in iOS6+ devices
  // and only when you first boot the iPhone, or play a audio/video
  // with a different sample rate
  if (context.sampleRate !== desiredSampleRate) {
    var buffer = context.createBuffer(1, 1, desiredSampleRate);
    var dummy = context.createBufferSource();
    dummy.buffer = buffer;
    dummy.connect(context.destination);
    dummy.start(0);
    dummy.disconnect();

    context.close(); // dispose old context
    context = new AudioCtor();
  }

  //  despite being in the moz docs, this doesn't work:
  //  if (context.state !== 'running') {
  //    throw new Error('Initial playback was not started in response to a user interaction!', context.state);
  //  }

  return context;
}

Speaker.prototype = {
  vol: 100, // 0..100
  outstandingSounds: {}, // Sound instances that have not yet been destroyed

  audioContext: null, // for mobile safari volume adjustment

  active: null, // active audio element, sound, and gain node
  fading: null, // fading audio element, sound, and gain node
  preparing: null, // preparing audio element, sound, and gain node

  // each of the above look like:
  // {
  //   audio: an HTML Audio element (created during initializeAudio() and reused)
  //   sound: refers to Sound object whose URL has been assigned to 'audio.src' and
  //          audio.play() has successfully returned.
  //   gain: AudioGainNode for iOS
  //   volume: relative volume of this sound (0..1)
  // }
  //
  // note that when audio.src is not SILENCE, and sound is null, we're waiting for
  // a return from audio.play(). If the audio.src is changed, or audio.pause() is called
  // before audio.play() returns, chrome will throw an error!
  //
  // When a sound is started, it is thrown into preparing.audio.src, then 'preparing' and
  // 'active' are swapped, then active.audio.play() is called.
  //
  // When a sound has completed playback or been destroyed, the sound property is set
  // to null, the audio is paused, and audio.src is set to SILENCE.

  prepareWhenReady: null, // url to prepare once audio is initialized

  attachEventHandlers(audioPlayer) {
    audioPlayer.on("closed", () => {
      if (audioPlayer.src === SILENCE) {
        return;
      }

      if (audioPlayer === this.fading.audio) {
        audioPlayer.src = SILENCE;
        this.fading.sound = null;
        return;
      }

      if (audioPlayer !== this.active.audio) {
        return;
      }

      if (!this.active.sound || this.active.sound.url !== audioPlayer.src) {
        log("active audio ended, but no matching sound", audioPlayer.src);
        return;
      }

      log("active audio ended");
      var sound = this.active.sound;
      this.active.sound = null;
      sound.trigger("finish");
    });

    audioPlayer.on("pause", () => {
      if (audioPlayer.src === SILENCE) {
        return;
      }

      if (
        audioPlayer !== this.active.audio ||
        audioPlayer.currentTime === audioPlayer.duration
      ) {
        return;
      }

      if (!this.active.sound || this.active.sound.url !== audioPlayer.src) {
        log("active audio pause, but no matching sound");
        return;
      }

      this.active.sound.trigger("pause");
    });

    audioPlayer.on("ontimeupdate", () => {
      console.log("ontimeupdate");

      console.log(audioPlayer?.currentTime, audioPlayer?.duration);

      if (audioPlayer.src === SILENCE) {
        return;
      }

      if (audioPlayer === this.fading.audio && this.fading.sound) {
        if (
          this.fading.sound.endPosition &&
          audioPlayer.currentTime >= this.fading.sound.endPosition / 1000
        ) {
          this.fading.sound = null;
          this.fading.audio.src = SILENCE;
        } else {
          this._setVolume(this.fading);
        }

        return;
      }

      if (audioPlayer !== this.active.audio) {
        return;
      }

      if (!this.active.sound) {
        // got an elapse event before the play() succeeded
        return;
      }

      if (this.active.sound.url !== audioPlayer.src) {
        log(
          "active audio elapsed, but no matching sound, so ignoring",
          audioPlayer.src
        );
        return;
      }

      if (
        this.active.sound.endPosition &&
        this.active.sound.endPosition / 1000 <= audioPlayer.currentTime
      ) {
        // song reached end of play
        var sound = this.active.sound;

        this.active.sound = null;

        this.active.audio.src = SILENCE;

        sound.trigger("finish");
      } else if (
        this.active.sound.fadeOutEnd &&
        audioPlayer.currentTime >= this.active.sound.fadeOutStart
      ) {
        // song hit start of fade out
        this._setVolume(this.active);

        // active becomes fading, and fading becomes active
        var fading = this.fading;
        this.fading = this.active;
        this.active = fading;

        this.active.sound = null; // not used any more

        // pretend the song finished
        this.fading.sound.trigger("finish");
      } else {
        this._setVolume(this.active);

        this.active.sound.trigger("elapse");
      }

      if (this.prepareWhenReady) {
        // we've got something we want to load. check if we've loaded
        // enough of the current song that we can start loading next song.
        this.prepare(this.prepareWhenReady);
      }
    });

    this.audioContext.onstatechange = () => {
      const currentState = this.audioContext?.state;
      console.log("Audo State Changing", currentState);
      if (currentState && currentState === "suspended") {
        audioPlayer.trigger("pause");
      } else if (currentState && currentState === `closed`) {
        audioPlayer.trigger("closed");
      }
    };
  },

  _createAudioPlayer: function (url) {
    return fetch(url)
      .then((response) => response.arrayBuffer())
      .then((audioData) => {
        let soundSource = this.audioContext.createBufferSource();

        return new Promise((resolve, reject) => {
          this.audioContext.decodeAudioData(
            audioData,
            (buffer) => {
              soundSource.buffer = buffer;
              soundSource.loop = true;
              soundSource.url = url;
              soundSource.sound = null;
              soundSource.volume = DEFAULT_VOLUME;

              // Create a gain node.
              if (!this.audioContext.createGain) {
                this.audioContext.createGain = this.audioContext.createGainNode;
              }

              var gainNode = this.audioContext.createGain();

              console.log(gainNode);
              // Connect the source to the gain node.
              soundSource.connect(gainNode);
              // Connect the gain node to the destination.
              gainNode.connect(this.audioContext.destination);

              soundSource.gain = gainNode;

              soundSource.audio = new AudioPlayer({
                url,
                buffer,
                source: soundSource,
                context: this.audioContext,
              });

              this.attachEventHandlers(soundSource.audio);

              return resolve(soundSource);
            },

            function (e) {
              console.log("Error with decoding audio data" + e);
              reject(e);
            }
          );
        });
      });
  },

  initializeAudio: function () {
    console.log("Attempting to Initialize Audio");

    // On mobile devices, we need to kick off playback of a sound in
    // response to a user event. This does that.
    if (this.active === null) {
      console.log("No active player, initializing");

      this.audioContext = createAudioContext();

      return Promise.all([
        this._createAudioPlayer(SILENCE),
        this._createAudioPlayer(SILENCE),
        this._createAudioPlayer(
          this.prepareWhenReady ? this.prepareWhenReady : SILENCE,
          this.audioContext
        ),
      ]).then(([active, fading, preparing]) => {
        console.log(active, fading, preparing);

        this.active = active;
        this.fading = fading;
        this.preparing = preparing;
        this.prepareWhenReady = null;
      });
    }
  },

  getSupportedFormats: function () {
    if (document.createElement("audio").canPlayType("audio/aac")) {
      return "aac,mp3";
    } else {
      return "mp3";
    }
  },

  _setVolume: function (audioGroup, sound) {
    console.log("SETTING VOLUME");
    if (!sound) {
      sound = audioGroup.sound;
    }

    var currentTime = audioGroup.audio.currentTime;
    var currentVolume = audioGroup.gain?.gain?.value;

    var calculatedVolume = sound.gainAdjustedVolume(this.vol);

    console.log(currentVolume, calculatedVolume);

    if (
      sound.fadeInStart !== sound.fadeInEnd &&
      currentTime < sound.fadeInStart
    ) {
      calculatedVolume = 0;

      console.log("pre-fade-in volume is 0");
    } else if (
      sound.fadeInStart !== sound.fadeInEnd &&
      currentTime >= sound.fadeInStart &&
      currentTime <= sound.fadeInEnd
    ) {
      // ramp up from 0 - 100%
      calculatedVolume =
        ((currentTime - sound.fadeInStart) /
          (sound.fadeInEnd - sound.fadeInStart)) *
        calculatedVolume;

      console.log("ramping ▲ volume", {
        currentTime: currentTime,
        currentVolume: currentVolume,
        calculatedVolume: calculatedVolume,
        sound: sound,
      });
    } else if (
      sound.fadeOutStart !== sound.fadeOutEnd &&
      currentTime > sound.fadeOutEnd
    ) {
      calculatedVolume = 0;

      console.log("post-fade-out volume is 0");
    } else if (
      sound.fadeOutStart !== sound.fadeOutEnd &&
      currentTime >= sound.fadeOutStart &&
      currentTime <= sound.fadeOutEnd
    ) {
      // ramp down from 100% to 0
      calculatedVolume =
        (1 -
          (currentTime - sound.fadeOutStart) /
            (sound.fadeOutEnd - sound.fadeOutStart)) *
        calculatedVolume;

      console.log("ramping ▼ volume", {
        currentTime: currentTime,
        currentVolume: currentVolume,
        calculatedVolume: calculatedVolume,
        sound: sound,
      });
    }

    // if (currentVolume !== calculatedVolume) {
    audioGroup.gain.gain.value = calculatedVolume;
    audioGroup.volume = calculatedVolume;

    console.log(audioGroup);
    // }
  },

  _debugAudioObject: function (object) {
    var events = [
      "abort",
      "load",
      "loadend",
      "loadstart",
      "loadeddata",
      "loadedmetadata",
      "canplay",
      "canplaythrough",
      "seeked",
      "seeking",
      "stalled",
      "timeupdate",
      "volumechange",
      "waiting",
      "durationchange",
      "progress",
      "emptied",
      "ended",
      "play",
      "pause",
    ];
    var speaker = this;

    for (var i = 0; i < events.length; i++) {
      object.addEventListener(events[i], function (event) {
        var audio = event.currentTarget;
        var name =
          audio === speaker.active.audio
            ? "active"
            : audio === speaker.preparing.audio
            ? "preparing"
            : "fading";

        log(name + ": " + event.type);
        log("    active: " + d(speaker.active.audio));
        log("    preparing: " + d(speaker.preparing.audio));
        log("    fading: " + d(speaker.fading.audio));

        if (audio.src === SILENCE) {
          return;
        }
      });
    }
  },

  // Create and return new sound object. This throws the song into
  // the preparing audio instance.
  create: function (url, optionsAndCallbacks) {
    var id = uniqueId("feed-play-");
    var sound = new Sound(this, optionsAndCallbacks, id, url);

    log("created play " + id + " (" + url + ")", optionsAndCallbacks);

    this.outstandingSounds[sound.id] = sound;

    // start loading sound, if we can
    if (!this.active || !this.active.audio) {
      log("no audio prepared yet, so preparing when ready");
      this.prepareWhenReady = sound.url;
    } else if (this.preparing.audio.src === SILENCE) {
      log("preparing sound now");
      this._prepare(sound.url, sound.startPosition);
    }

    return sound;
  },

  prepare: function (url) {
    if (!this.active || !this.active.audio) {
      console.log("saving url to prepare for later", url);
      this.prepareWhenReady = url;
      return;
    }

    // var ranges = this.active.audio?.buffered;
    // if (
    //   ranges.length > 0 &&
    //   ranges.end(ranges.length - 1) >= this.active.audio.duration
    // ) {
    //   console.log("active song has loaded enough, to preparing", url);
    //   return this._prepare(url, 0);
    // }

    if (this.active.audio.src === SILENCE) {
      console.log("preparing over silence");
      return this._prepare(url, 0);
    }

    // still loading primary audio - so hold off for now
    console.log("nothing available to do active prepare");
    this.prepareWhenReady = url;
  },

  /* eslint-disable no-console */
  logState: function (label) {
    // local testing:
    console.group("speaker: " + (label || ""));

    if (!this.active) {
      console.group("active");
      console.log("uninitialized");
      console.groupEnd();

      console.group("preparing");
      console.log("uninitialized");
      console.groupEnd();

      console.group("fading");
      console.log("uninitialized");
      console.groupEnd();
    } else {
      console.group("active");
      console.log(`audio.src: ${this.active.audio.src}`);
      console.log(`audio.paused: ${this.active.audio.paused}`);
      console.log(
        `sound: ${this.active.sound ? this.active.sound.id : "NULL"}`
      );
      console.log(`volume: ${this.active.volume}`);
      console.groupEnd();

      console.group("preparing");
      console.log(`audio.src: ${this.preparing.audio.src}`);
      console.log(`audio.paused: ${this.preparing.audio.paused}`);
      console.log(
        `sound: ${this.preparing.sound ? this.preparing.sound.id : "NULL"}`
      );
      console.log(`volume: ${this.preparing.volume}`);
      console.groupEnd();

      console.group("fading");
      console.log(`audio.src: ${this.fading.audio.src}`);
      console.log(`audio.paused: ${this.fading.audio.paused}`);
      console.log(
        `sound: ${this.fading.sound ? this.fading.sound.id : "NULL"}`
      );
      console.log(`volume: ${this.fading.volume}`);
      console.groupEnd();
    }

    console.group("outstanding sounds");
    for (let id in this.outstandingSounds) {
      let play = this.outstandingSounds[id];
      console.log(play.id + ": " + play.url);
    }
    console.groupEnd();

    console.groupEnd();
  },

  _prepare: function (url, startPosition) {
    // empty out any pending request
    this.prepareWhenReady = null;

    if (this.preparing.audio.src !== url) {
      console.log("preparing " + url);
      this.audioContext = createAudioContext();

      return this._createAudioPlayer(url).then((preparing) => {
        this.preparing = preparing;
      });
    }

    if (startPosition && this.preparing.audio.currentTime !== startPosition) {
      log("advancing preparing audio to", startPosition / 1000);
      this.preparing.audio.currentTime = startPosition / 1000;
    }
  },

  /*
   * Kick off playback of the requested sound.
   */

  _playSound: function (sound) {
    var speaker = this;

    if (!this.active || !this.active.audio) {
      // eslint-disable-next-line
      console.error(
        "**** player.initializeAudio() *** not called before playback!"
      );
      return;
    }

    if (this.active.sound === sound) {
      if (this.active.audio.paused) {
        console.log(sound.id + " was paused, so resuming");

        // resume playback
        this.active.audio
          .play()
          .then(function () {
            log("resumed playback");
            sound.trigger("play");
          })
          .catch(function () {
            log("error resuming playback");
            speaker.active.sound = null;
            sound.trigger("finish");
          });

        if (this.fading.sound) {
          this.fading.audio
            .play()
            .then(function () {
              log("resumed fading playback");
            })
            .catch(function () {
              log("error resuming fading playback");
              speaker.fading.sound = null;
              speaker.fading.audio.src = SILENCE;
            });
        }
      } else {
        console.log(sound.id + " is already playing");
      }
    } else {
      console.log("YOOO", this.preparing.audio.src, sound.url);

      const assemblePlay = () => {
        // swap prepared -> active
        var active = this.active;
        this.active = this.preparing;
        this.preparing = active;

        // don't throw sound object in active until playback starts (below)
        this.active.sound = null;
        this._setVolume(this.active, sound);

        // notify clients that whatever was previously playing has finished
        if (this.preparing.sound) {
          this.preparing.audio.src = SILENCE;

          var finishedSound = this.preparing.sound;
          this.preparing.sound = null;
          finishedSound.trigger("finish");
        }

        console.log(sound.id + " initiating play()");

        var me = this.active;

        this.active.audio
          .play()
          .then(function () {
            if (!speaker.outstandingSounds[sound.id]) {
              log(sound.id + " play() succeeded, but sound has been destroyed");

              // this sound was killed before playback began - make sure to stop it
              if (me.audio && me.audio.src === sound.url) {
                log(sound.id + " being paused and unloaded");
                me.audio.pause();
                me.audio.src = SILENCE;
              }

              return;
            }

            console.log(sound.id + " play() succeeded");
            me.sound = sound;

            // configure fade-out now that metadata is loaded
            if (sound.fadeOutSeconds && sound.fadeOutEnd === 0) {
              sound.fadeOutStart = me.audio.duration - sound.fadeOutSeconds;
              sound.fadeOutEnd = me.audio.duration;
            }

            if (sound.startPosition) {
              log("updating start position");
              me.audio.currentTime = sound.startPosition / 1000;
              log("updated");
            }

            var paused = me.audio.paused;

            sound.trigger("play");

            if (me.pauseAfterPlay) {
              me.audio.pause();
            } else if (paused) {
              sound.trigger("pause");
            }
          })
          .catch(function (error) {
            log("error starting playback with sound " + sound.id, error);
            sound.trigger("finish", error);
          });
      };

      if (this.preparing.audio.src !== sound.url) {
        console.log("preparing");
        // hopefully, by this time, any sound that was destroyed before its
        // play() call completed has actually completed its play call. Otherwise
        // this will trigger an exception in the play preparation.
        this._prepare(sound.url, sound.startPosition).then(() => {
          assemblePlay();
        });
        return;

        /*
                } else if (sound.startPosition && (this.preparing.audio.currentTime !== sound.startPosition)) {
                  log('advancing prepared audio to', sound.startPosition / 1000);
                  this.preparing.audio.currentTime = sound.startPosition / 1000;
                  */
      }

      assemblePlay();

      // // swap prepared -> active
      // var active = this.active;
      // this.active = this.preparing;
      // this.preparing = active;

      // // don't throw sound object in active until playback starts (below)
      // this.active.sound = null;
      // this._setVolume(this.active, sound);

      // // notify clients that whatever was previously playing has finished
      // if (this.preparing.sound) {
      //   this.preparing.audio.src = SILENCE;

      //   var finishedSound = this.preparing.sound;
      //   this.preparing.sound = null;
      //   finishedSound.trigger("finish");
      // }

      // console.log(sound.id + " initiating play()");

      // var me = this.active;

      // this.active.audio
      //   .play()
      //   .then(function () {
      //     if (!speaker.outstandingSounds[sound.id]) {
      //       log(sound.id + " play() succeeded, but sound has been destroyed");

      //       // this sound was killed before playback began - make sure to stop it
      //       if (me.audio && me.audio.src === sound.url) {
      //         log(sound.id + " being paused and unloaded");
      //         me.audio.pause();
      //         me.audio.src = SILENCE;
      //       }

      //       return;
      //     }

      //     console.log(sound.id + " play() succeeded");
      //     me.sound = sound;

      //     // configure fade-out now that metadata is loaded
      //     if (sound.fadeOutSeconds && sound.fadeOutEnd === 0) {
      //       sound.fadeOutStart = me.audio.duration - sound.fadeOutSeconds;
      //       sound.fadeOutEnd = me.audio.duration;
      //     }

      //     if (sound.startPosition) {
      //       log("updating start position");
      //       me.audio.currentTime = sound.startPosition / 1000;
      //       log("updated");
      //     }

      //     var paused = me.audio.paused;

      //     sound.trigger("play");

      //     if (me.pauseAfterPlay) {
      //       me.audio.pause();
      //     } else if (paused) {
      //       sound.trigger("pause");
      //     }
      //   })
      //   .catch(function (error) {
      //     log("error starting playback with sound " + sound.id, error);
      //     sound.trigger("finish", error);
      //   });
    }
  },

  _destroySound: function (sound) {
    console.log("calling destroy sound");
    sound.off();

    if (this.active && this.active.sound === sound) {
      console.log("destroy triggered for current sound", sound.id);
      this.active.audio.pause();
    } else {
      console.log("destroy triggered for inactive sound", sound.id);

      // if (this.active && (this.active.audio.src === sound.url)) {
      //   We're destroying the active sound, but it hasn't completed its play()
      //   yet (indicated by this.active.sound === sound), so we can't pause it
      //   here. When the play does complete, it will notice it isn't in the
      //   outstandingSounds map and it will pause itself
      // }
    }

    delete this.outstandingSounds[sound.id];
  },

  flush: function () {
    // destroy all outstanding sound objects

    console.log("FLUSHING THINGS");

    console.log(this.outstandingSounds);
    for (let id in this.outstandingSounds) {
      this.outstandingSounds[id].destroy();
    }
  },

  _pauseSound: function (sound) {
    console.log("Pause Sound Called");
    if (this.active && sound.url === this.active.audio.src) {
      if (this.active.sound === sound) {
        this.active.audio.pause();
      } else {
        // if active.sound isn't assigned, then the song is still being loaded.
        // if we try to pause() right now, it will cause the play() to throw an
        // exception... so just throw up a flag for this
        this.active.pauseAfterPlay = true;
      }
    }

    if (this.fading && this.fading.audio) {
      this.fading.audio.pause();
    }
  },

  _position: function (sound) {
    if (this.active && sound === this.active.sound) {
      if (sound.url !== this.active.audio.src) {
        log(
          "trying to get current song position, but it is not in the active audio player"
        );
      }

      return Math.floor(this.active.audio.currentTime * 1000);
    } else {
      return 0;
    }
  },

  _duration: function (sound) {
    if (sound === this.active.sound) {
      if (sound.url !== this.active.audio.src) {
        log(
          "trying to get current song duration, but it is not in the active audio player"
        );
      }
      var d = this.active.audio.duration;
      return isNaN(d) ? 0 : Math.floor(d * 1000);
    } else {
      return 0;
    }
  },

  // set the volume (0-100)
  setVolume: function (value) {
    if (typeof value !== "undefined") {
      this.vol = value;

      if (this.active && this.active.sound) {
        this._setVolume(this.active);
      }

      this.trigger("volume", value);
    }

    return this.vol;
  },

  getVolume: function () {
    return this.vol;
  },
};

// add events to speaker class
Object.assign(Speaker.prototype, Events);

export default Speaker;
