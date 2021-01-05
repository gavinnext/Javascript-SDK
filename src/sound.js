import Events from "./events";

var Sound = function (speaker, options, id, url) {
  var obj = Object.assign(this, Events);

  obj.id = id;

  //url = url.replace('u9e9h7z5.map2.ssl.hwcdn.net', 's3.amazonaws.com');

  obj.url = url;
  obj.speaker = speaker;
  obj.loaded = false;

  if (options) {
    this.startPosition = +options.startPosition;
    this.endPosition = +options.endPosition;

    this.fadeInSeconds = +options.fadeInSeconds;
    if (this.fadeInSeconds) {
      this.fadeInStart = this.startPosition ? this.startPosition / 1000 : 0;
      this.fadeInEnd = this.fadeInStart + this.fadeInSeconds;
    } else {
      this.fadeInStart = 0;
      this.fadeInEnd = 0;
    }

    this.fadeOutSeconds = +options.fadeOutSeconds;
    if (this.fadeOutSeconds) {
      if (this.endPosition) {
        this.fadeOutStart = this.endPosition / 1000 - this.fadeOutSeconds;
        this.fadeOutEnd = this.endPosition / 1000;
      } else {
        this.fadeOutStart = 0;
        this.fadeOutEnd = 0;
      }
    }

    for (let ev of ["play", "pause", "finish", "elapse"]) {
      if (ev in options) {
        obj.on(ev, options[ev]);
      }
    }

    this.gain = options.gain || 0;
  } else {
    this.gain = 0;
  }

  return obj;
};

export default Sound;
