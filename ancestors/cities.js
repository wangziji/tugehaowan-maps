/* 预设锚点坐标：腾讯位置服务 WebService 地址解析（geocoder/v1）真实返回，预生成为静态数据，
   运行时不再调用接口，避免配额与网络依赖。生成时间 2026-10-17。 */
var AF_CITIES = [
  { name: '北京', lat: 39.905023, lng: 116.724502 },
  { name: '西安', lat: 34.343207, lng: 108.939645 },
  { name: '洛阳', lat: 34.619702, lng: 112.453895 },
  { name: '开封', lat: 34.798083, lng: 114.314278 },
  { name: '杭州', lat: 30.246026, lng: 120.210792 },
  { name: '泉州', lat: 24.874452, lng: 118.675724 },
  { name: '成都', lat: 30.572961, lng: 104.066301 },
  { name: '广州', lat: 23.130061, lng: 113.264499 }
];
if (typeof module !== 'undefined' && module.exports) module.exports = AF_CITIES;
