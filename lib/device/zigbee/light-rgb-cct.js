import platformConsts from '../../utils/constants.js';
import { generateRandomString, hasProperty, sleep } from '../../utils/functions.js';

export default class {
  constructor(platform, accessory) {
    // Set up variables from the platform
    this.hapChar = platform.api.hap.Characteristic;
    this.hapErr = platform.api.hap.HapStatusError;
    this.hapServ = platform.api.hap.Service;
    this.lang = platform.lang;
    this.log = platform.log;
    this.platform = platform;

    // Set up variables from the accessory
    this.name = accessory.displayName;
    this.accessory = accessory;

    // Set up custom variables for this device type
    const deviceConf = platform.deviceConf[accessory.context.eweDeviceId] || {};
    this.brightStep = deviceConf.brightnessStep
      ? Math.min(deviceConf.brightnessStep, 100)
      : platformConsts.defaultValues.brightnessStep;

    // Set the correct logging variables for this accessory
    switch (deviceConf.overrideLogging) {
      case 'standard':
        this.enableLogging = true;
        this.enableDebugLogging = false;
        break;
      case 'debug':
        this.enableLogging = true;
        this.enableDebugLogging = true;
        break;
      case 'disable':
        this.enableLogging = false;
        this.enableDebugLogging = false;
        break;
      default:
        this.enableLogging = !platform.config.disableDeviceLogging;
        this.enableDebugLogging = platform.config.debug;
        break;
    }

    // Add the lightbulb service if it doesn't already exist
    this.service = this.accessory.getService(this.hapServ.Lightbulb)
      || this.accessory.addService(this.hapServ.Lightbulb);

    // Add the get/set handler to the lightbulb on/off characteristic
    this.service
      .getCharacteristic(this.hapChar.On)
      .onSet(async (value) => this.internalStateUpdate(value));

    // Add the set handler to the lightbulb brightness characteristic
    this.service
      .getCharacteristic(this.hapChar.Brightness)
      .setProps({ minStep: this.brightStep })
      .onSet(async (value) => this.internalBrightnessUpdate(value));

    // Add the set handler to the lightbulb hue characteristic
    this.service
      .getCharacteristic(this.hapChar.Hue)
      .onSet(async (value) => this.internalColourUpdate(value));
    this.cacheSat = this.service.getCharacteristic(this.hapChar.Saturation).value;

    // This is needed as sometimes we need to send the brightness with a cct update
    this.cacheBright = this.service.getCharacteristic(this.hapChar.Brightness).value;

    // Add the get handlers only if the user hasn't disabled the disableNoResponse setting
    if (!platform.config.disableNoResponse) {
      this.service.getCharacteristic(this.hapChar.On).onGet(() => {
        if (!this.isOnline) {
          throw new this.hapErr(-70402);
        }
        return this.service.getCharacteristic(this.hapChar.On).value;
      });
      this.service
        .getCharacteristic(this.hapChar.Brightness)
        .onGet(() => {
          if (!this.isOnline) {
            throw new this.hapErr(-70402);
          }
          return this.service.getCharacteristic(this.hapChar.Brightness).value;
        });
      this.service.getCharacteristic(this.hapChar.Hue).onGet(() => {
        if (!this.isOnline) {
          throw new this.hapErr(-70402);
        }
        return this.service.getCharacteristic(this.hapChar.Hue).value;
      });
    }

    // Output the customised options to the log
    const normalLogging = this.enableLogging ? 'standard' : 'disable';
    const opts = JSON.stringify({
      brightnessStep: this.brightStep,
      logging: this.enableDebugLogging ? 'debug' : normalLogging,
    });
    this.log('[%s] %s %s.', this.name, this.lang.devInitOpts, opts);
  }

  async internalStateUpdate(value) {
    try {
      const newValue = value ? 'on' : 'off';
      await this.platform.sendDeviceUpdate(this.accessory, {
        switch: newValue,
      });
      this.cacheState = newValue;
      if (this.enableLogging) {
        this.log('[%s] %s [%s].', this.name, this.lang.curState, this.cacheState);
      }
    } catch (err) {
      this.platform.deviceUpdateError(this.accessory, err, true);
      setTimeout(() => {
        this.service.updateCharacteristic(this.hapChar.On, this.cacheState === 'on');
      }, 2000);
      throw new this.hapErr(-70402);
    }
  }

  async internalBrightnessUpdate(value) {
    try {
      if (this.cacheBright === value || value === 0) {
        return;
      }
      const updateKey = generateRandomString(5);
      this.updateKeyBright = updateKey;
      await sleep(500);
      if (updateKey !== this.updateKeyBright) {
        return;
      }
      const params = {};
      switch (this.cacheMode) {
        case 'color':
          params.rgbBrightness = value;
          break;
        case 'white':
          params.cctBrightness = value;
          break;
        default:
          throw new Error('Color mode not set');
      }

      await this.platform.sendDeviceUpdate(this.accessory, params);
      this.cacheBright = value;
      if (this.enableLogging) {
        this.log('[%s] %s [%s%].', this.name, this.lang.curBright, this.cacheBright);
      }
    } catch (err) {
      this.platform.deviceUpdateError(this.accessory, err, true);
      setTimeout(() => {
        this.service.updateCharacteristic(this.hapChar.Brightness, this.cacheBright);
      }, 2000);
      throw new this.hapErr(-70402);
    }
  }

  async internalColourUpdate(value) {
    try {
      if (this.cacheHue === value) {
        return;
      }
      const updateKey = generateRandomString(5);
      this.updateKey = updateKey;
      await sleep(400);
      if (updateKey !== this.updateKey) {
        return;
      }
      this.updateTimeout = updateKey;
      setTimeout(() => {
        if (this.updateTimeout === updateKey) {
          this.updateTimeout = false;
        }
      }, 5000);
      this.service.updateCharacteristic(this.hapChar.ColorTemperature, 140);
      const params = {
        hue: value,
        saturation: this.cacheSat,
      };
      if (this.cacheMode !== 'color') {
        params.colorMode = 'rgb';
      }
      await this.platform.sendDeviceUpdate(this.accessory, params);
      this.cacheHue = value;
      this.cacheSat = this.service.getCharacteristic(this.hapChar.Saturation).value;
      this.cacheMired = 0;
      this.cacheCT = 0;
      this.cacheMode = 'color';
      if (this.enableLogging) {
        this.log(
          '[%s] %s [hue %s saturation %s].',
          this.name,
          this.lang.curColour,
          `${this.cacheHue} ${this.cacheSat}`,
        );
      }
    } catch (err) {
      this.platform.deviceUpdateError(this.accessory, err, true);
      setTimeout(() => {
        this.service.updateCharacteristic(this.hapChar.Hue, this.cacheHue);
      }, 2000);
      throw new this.hapErr(-70402);
    }
  }

  async externalUpdate(params) {
    try {
      if (params.switch && params.switch !== this.cacheState) {
        this.cacheState = params.switch;
        this.service.updateCharacteristic(this.hapChar.On, this.cacheState === 'on');
        if (params.updateSource && this.enableLogging) {
          this.log('[%s] %s [%s].', this.name, this.lang.curState, this.cacheState);
        }
      }

      // How to tell which mode the bulb is in
      // params.colorMode can be "rgb" or "cct"
      // params.rgbBrightness is the brightness of the bulb when in rgb mode 0-100
      // params.cctBrightness is the brightness of the bulb when in cct mode 0-100
      // params.colorTemp is the colour temperature of the bulb when in cct mode 0-100
      // params.hue is the hue of the bulb when in rgb mode 0-360
      // params.saturation is the saturation of the bulb when in rgb mode 0-100
      if (
        params.colorMode === 'rgb'
        || hasProperty(params, 'rgbBrightness')
        || hasProperty(params, 'hue')
        || hasProperty(params, 'saturation')
      ) {
        this.cacheMode = 'color';

        if (hasProperty(params, 'rgbBrightness') && params.rgbBrightness !== this.cacheBright) {
          this.cacheBright = params.rgbBrightness;
          this.service.updateCharacteristic(this.hapChar.Brightness, this.cacheBright);
          if (params.updateSource && this.enableLogging) {
            this.log('[%s] %s [%s%].', this.name, this.lang.curBright, this.cacheBright);
          }
          this.cacheBright = params.rgbBrightness;
          this.service.updateCharacteristic(this.hapChar.Brightness, this.cacheBright);
        }
        if (
          (hasProperty(params, 'hue') && params.hue !== this.cacheHue)
          || (hasProperty(params, 'saturation') && params.saturation !== this.cacheSat)
        ) {
          this.cacheHue = hasProperty(params, 'hue') ? params.hue : this.cacheHue;
          this.cacheSat = hasProperty(params, 'saturation') ? params.saturation : this.cacheSat;
          this.service.updateCharacteristic(this.hapChar.Hue, this.cacheHue);
          this.service.updateCharacteristic(this.hapChar.Saturation, this.cacheSat);
          if (params.updateSource && this.enableLogging) {
            this.log(
              '[%s] %s [hue %s saturation %s].',
              this.name,
              this.lang.curColour,
              `${this.cacheHue} ${this.cacheSat}`,
            );
          }
        }
      } else if (
        params.colorMode === 'cct'
        || hasProperty(params, 'cctBrightness')
        || hasProperty(params, 'colorTemp')
      ) {
        this.cacheMode = 'white';
        if (hasProperty(params, 'cctBrightness') && params.cctBrightness !== this.cacheBright) {
          this.cacheBright = params.cctBrightness;
          this.service.updateCharacteristic(this.hapChar.Brightness, this.cacheBright);
          if (params.updateSource && this.enableLogging) {
            this.log('[%s] %s [%s%].', this.name, this.lang.curBright, this.cacheBright);
          }
        }
      }
    } catch (err) {
      this.platform.deviceUpdateError(this.accessory, err, false);
    }
  }

  markStatus(isOnline) {
    this.isOnline = isOnline;
  }
}