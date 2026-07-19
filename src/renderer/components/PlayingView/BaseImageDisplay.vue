<script>
import { h } from 'vue';

export default {
  name: 'BaseImageDisplay',
  props: {
    imgSrc: {
      required: true,
      type: [String, Blob],
    },
    imageStyle: {
      type: Object,
      required: true,
    },
    attributes: {
      type: Object,
      required: true,
    },
    width: {
      type: Number,
      required: true,
    },
    height: {
      type: Number,
      required: true,
    },
  },
  data() {
    return {
      predefinedTypes: [
        'DataURI',
        'URL',
        'Blob',
        'ImageBitmap',
        'ImageData',
      ],
      imageReady: false,
    };
  },
  computed: {
    imageType() {
      return this.getImageType(this.imgSrc);
    },
    elementName() {
      return this.getElementName(this.imageType);
    },
    imageOptions() {
      return this.getImageOptions(this.imgSrc, this.imageType);
    },
  },
  beforeUpdate() {
    switch (this.imageType) {
      default: {
        this.imageReady = true;
        break;
      }
      case null: {
        break;
      }
      case 'ImageBitmap': {
        if (this.$refs.image.getContext) {
          this.$refs.image.getContext('2d').drawImage(this.imgSrc, 0, 0, this.width, this.height);
          this.imageReady = true;
        }
        break;
      }
      case 'ImageData': {
        if (this.$refs.image.getContext) {
          createImageBitmap(this.imgSrc).then((image) => {
            this.$refs.image.getContext('2d').drawImage(image, 0, 0, this.width, this.height);
            this.imageReady = true;
          });
        }
        break;
      }
    }
  },
  mounted() {
    switch (this.imageType) {
      default: {
        this.imageReady = true;
        break;
      }
      case null: {
        break;
      }
      case 'ImageBitmap': {
        if (this.$refs.image.getContext) {
          this.$refs.image.getContext('2d').drawImage(this.imgSrc, 0, 0, this.width, this.height);
          this.imageReady = true;
        }
        break;
      }
      case 'ImageData': {
        if (this.$refs.image.getContext) {
          createImageBitmap(this.imgSrc).then((image) => {
            this.$refs.image.getContext('2d').drawImage(image, 0, 0, this.width, this.height);
            this.imageReady = true;
          });
        }
        break;
      }
    }
    this.$refs.image.dataset.componentName = this.$options.name;
  },
  methods: {
    getImageType(imgSrc) {
      const src = imgSrc;
      let imgType = null;
      if (typeof src === 'string') {
        const imgURLRegexes = {
          URL: new RegExp(/^https?:\/\//),
          DataURI: new RegExp(/^data:image\//),
        };
        Object.keys(imgURLRegexes).forEach((regType) => {
          if (imgURLRegexes[regType].test(src)) {
            imgType = regType;
          }
        });
      } else if (typeof src === 'object') {
        if (typeof Blob !== 'undefined' && src instanceof Blob) return 'Blob';
        if (typeof ImageData !== 'undefined' && src instanceof ImageData) return 'ImageData';
        if (typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap) return 'ImageBitmap';
        const type = Object.prototype.toString.call(src).slice(8, -1);
        this.predefinedTypes.slice(2).forEach((predefinedType) => {
          if (type === predefinedType) {
            imgType = predefinedType;
          }
        });
      }
      return imgType;
    },
    getElementName(imageType) {
      const type = imageType;
      let elementName = null;
      switch (type) {
        default: {
          elementName = 'span';
          break;
        }
        case 'URL':
        case 'DataURI':
        case 'Blob': {
          elementName = 'img';
          break;
        }
        case 'ImageBitmap':
        case 'ImageData': {
          elementName = 'canvas';
          break;
        }
      }
      return elementName;
    },
    getImageOptions(imgSrc, imageType) {
      const type = imageType;
      let options = {};
      const outerWidth = this.width ? `${this.width}px` : '100%';
      const outerHeight = this.height ? `${this.height}px` : '100%';

      options = {
        style: this.imageStyle,
        width: outerWidth,
        height: outerHeight,
        ...this.attributes,
        ref: 'image',
      };
      switch (type) {
        case 'URL':
        case 'DataURI': {
          options.src = imgSrc;
          break;
        }
        case 'Blob': {
          const url = URL.createObjectURL(imgSrc);
          options.src = url;
          break;
        }
        default: {
          break;
        }
      }

      return options;
    },
  },
  render() {
    const visibilityOptions = this.imageReady
      ? this.imageOptions
      : Object.assign(
        {},
        this.imageOptions,
        {
          style: Object.assign(
            {},
            this.imageStyle,
            { visibility: false },
          ),
        },
      );
    return h(this.elementName, visibilityOptions);
  },
};
</script>
