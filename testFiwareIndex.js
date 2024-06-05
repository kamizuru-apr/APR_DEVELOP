const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const { createLogger, format, transports } = require('winston');
const fs = require('fs');
const axios = require('axios');
const csvtojson = require('csvtojson');

const app = express();
const port = 3001;
const orionEndpoint = 'http://localhost:8000/orion/v2/entities?type=EvacuationSpace'; // Kong Gateway経由のURLに変更
//const orionEndpoint = 'http://localhost:1026/v2/entities?type=EvacuationSpace';
const FiwareService = 'fiware_project';
const csvFilePath = path.join(__dirname, 'ibaraki.csv');

// ログの設定
const logger = createLogger({
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.printf(info => `${info.timestamp}: ${info.level}: ${info.message}`)
  ),
  transports: [new transports.Console(), new transports.File({ filename: 'app.log' })]
});

app.use(express.static('/var/www/app'));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'fiware', resave: false, saveUninitialized: true }));
app.use(express.json());

// HTTPサーバーの起動
app.listen(port, '0.0.0.0', function() {
  console.log(`HTTP server listening on port ${port}`);
});

// APIエンドポイントの設定
app.get('/api/getOrionData', async (req, res) => {
  const limit = 1000; // 1回のリクエストで取得するエンティティの数
  let offset = 0; // リクエストのオフセット
  let allData = []; // 取得したデータを格納する配列
  let hasMoreData = true; // データがまだあるかどうかのフラグ

  try {
    console.log('Received request to /api/getOrionData');
    while (hasMoreData) {
      const response = await axios.get(`${orionEndpoint}&limit=${limit}&offset=${offset}`, {
        headers: {
          'Fiware-Service': FiwareService,
        }
      });

      const data = response.data;
      allData = allData.concat(data);

      if (data.length < limit) {
        hasMoreData = false; // 取得したデータがlimit未満なら終了
      } else {
        offset += limit; // 次のページのオフセットを設定
      }
    }

    console.log('Data fetched from Orion:', allData.length);
    res.json(allData);
  } catch (error) {
    if (error.response) {
      console.error('Error response data:', error.response.data);
      console.error('Error response status:', error.response.status);
      console.error('Error response headers:', error.response.headers);
      res.status(500).send(`Error fetching data from Orion: ${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
      console.error('Error request:', error.request);
      res.status(500).send('Error fetching data from Orion: No response received from server');
    } else {
      console.error('Error message:', error.message);
      res.status(500).send(`Error fetching data from Orion: ${error.message}`);
    }
    console.error('Error config:', error.config);
  }
});


// CSVファイルをJSONに変換してOrionに送信する関数
async function convertCsvToJsonAndSendToOrion(csvFilePath) {
  try {
    if (!fs.existsSync(csvFilePath)) {
      throw new Error('File does not exist. Check to make sure the file path to your csv is correct.');
    }

    const jsonArray = await csvtojson().fromFile(csvFilePath);
    logger.info('Converted JSON:', JSON.stringify(jsonArray, null, 2));

    // Orionにsubscriptionsを送信
    const orionSubscriptionEndpoint = 'http://localhost:8000/orion/v2/subscriptions'; // Kong Gateway経由のURLに変更
    //const orionSubscriptionEndpoint = 'http://localhost:1026/v2/subscriptions';
    await axios.post(orionSubscriptionEndpoint, {
      "description": "Notify Quantumleap of all context changes",
      "subject": {
        "entities": [{"idPattern": ".*"}]
      },
      "notification": {
        "http": {"url": "http://quantumleap:8668/v2/notify"},
        "metadata": ["dateCreated", "dateModified"]
      }
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Fiware-Servicepath': '/',
        'Fiware-Service': FiwareService,
      }
    });

    let registeredEntitiesCount = 0;
    for (const item of jsonArray) {
      const entityId = `EvacuationSpace_${item["市町村コード"]}_${item["NO"]}`;
      const latitude = parseFloat(item["緯度"]);
      const longitude = parseFloat(item["経度"]);
      const entity = {
        id: entityId,
        type: 'EvacuationSpace',
        identification: { value: item["市町村コード"] + item["NO"], type: "String" },
        name: { value: item["施設・場所名"], type: "String" },
        fullAddress: { value: item["都道府県名及び市町村名"] + item["住所"], type: "String" },
        latitude: { value: !isNaN(latitude) ? latitude : null, type: "Number" },
        longitude: { value: !isNaN(longitude) ? longitude : null, type: "Number" },
        contactPointPhoneNumber: { value: null, type: "String" },
        localGovernmentCode: { value: item["市町村コード"], type: "String" },
        floodFromRivers: { value: item["洪水"], type: "String" },
        steepSlopeFailureLandSlide: { value: item["崖崩れ、土石流及び地滑り"], type: "String" },
        stormSurges: { value: item["高潮"], type: "String" },
        earthquake: { value: item["地震"], type: "String" },
        tsunami: { value: item["津波"], type: "String" },
        fireDisasters: { value: item["大規模な火事"], type: "String" },
        floodFromInlandWaters: { value: item["内水氾濫"], type: "String" },
        volcanicDisasters: { value: item["火山現象"], type: "String" },
        duplicated: { value: item["指定避難所との住所同一"], type: "String" },
        evacuationCapacity: { value: null, type: "String" }
      };

      logger.info('Entity to be sent:', JSON.stringify(entity, null, 2));

      try {
        const getEntityResponse = await axios.get(`http://localhost:8000/orion/v2/entities/${entityId}`, {
        //const getEntityResponse = await axios.get(`http://localhost:1026/v2/entities/${entityId}`, {
          headers: {
            'Fiware-Servicepath': '/',
            'Fiware-Service': FiwareService
          }
        });

        if (getEntityResponse.status === 200) {
          const updateEntity = { ...entity };
          delete updateEntity.id;
          delete updateEntity.type;
          
          await axios.post(`http://localhost:8000/orion/v2/entities/${entityId}/attrs?type=EvacuationSpace`, updateEntity, {
          //await axios.post(`http://localhost:1026/v2/entities/${entityId}/attrs?type=EvacuationSpace`, updateEntity, {
            headers: {
              'Content-Type': 'application/json',
              'Fiware-Servicepath': '/',
              'Fiware-Service': FiwareService,
            }
          });
          logger.info('Orionにデータを更新しました:', entityId);
        }
      } catch (error) {
        if (error.response && error.response.status === 404) {
          try {
            await axios.post('http://localhost:8000/orion/v2/entities', entity, {
            //await axios.post('http://localhost:1026/v2/entities', entity, {
              headers: {
                'Content-Type': 'application/json',
                'Fiware-Servicepath': '/',
                'Fiware-Service': FiwareService,
              }
            });
            registeredEntitiesCount++;
            logger.info('Orionにデータを作成しました:', entityId);
          } catch (createError) {
            logger.error('Orionにデータ作成中にエラーが発生しました:', createError.response ? createError.response.data : createError.message);
          }
        } else {
          logger.error('Orionのエンティティ確認中にエラーが発生しました:', error.response ? error.response.data : error.message);
        }
      }
    }
    logger.info(`Total entities registered in Orion: ${registeredEntitiesCount}`);
  } catch (error) {
    logger.error('変換中または送信中にエラーが発生しました:', error.message);
  }
}

convertCsvToJsonAndSendToOrion(csvFilePath);
