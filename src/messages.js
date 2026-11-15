'use strict';
/** Сообщения сервера на трёх языках и ошибки, которые показываются пользователю. */
const { LANGS } = require('./config');

const SM = {
  timeout: { ru: 'Расчёт превысил лимит времени ({s} с)', kk: 'Есептеу уақыт шегінен асып кетті ({s} с)', en: 'The calculation exceeded the time limit ({s} s)' },
  no_python: { ru: 'Не удалось запустить Python ({py}): {msg}. Задайте PYTHON_BIN.', kk: 'Python іске қосылмады ({py}): {msg}. PYTHON_BIN орнатыңыз.', en: 'Could not start Python ({py}): {msg}. Set PYTHON_BIN.' },
  no_result: { ru: 'Python не вернул результат', kk: 'Python нәтиже қайтармады', en: 'Python returned no result' },
  calc_error: { ru: 'Ошибка расчёта', kk: 'Есептеу қатесі', en: 'Calculation error' },
  bad_json: { ru: 'Python вернул некорректный JSON', kk: 'Python қате JSON қайтарды', en: 'Python returned invalid JSON' },
  no_model: { ru: 'Нет aquacrop_model.onnx / model_meta.json - запустите python generate_model.py', kk: 'aquacrop_model.onnx / model_meta.json жоқ — python generate_model.py іске қосыңыз', en: 'aquacrop_model.onnx / model_meta.json are missing — run python generate_model.py' },
  model_load: { ru: 'Не удалось загрузить ИИ-модель: {msg}', kk: 'ЖИ моделі жүктелмеді: {msg}', en: 'Could not load the AI model: {msg}' },
  model_off: { ru: 'ИИ-модель не загружена', kk: 'ЖИ моделі жүктелмеген', en: 'The AI model is not loaded' },
  ai_nan: { ru: 'ИИ вернул нечисловой результат', kk: 'ЖИ сандық емес нәтиже қайтарды', en: 'The AI returned a non-numeric result' },
  ai_na: { ru: 'ИИ не применим к выбранным файлам', kk: 'ЖИ таңдалған файлдарға қолданылмайды', en: 'The AI does not apply to the selected files' },
  ext: { ru: 'Можно загружать только {list}', kk: 'Тек {list} файлдарын жүктеуге болады', en: 'Only {list} files can be uploaded' },
  name: { ru: 'Имя файла: только буквы, цифры, пробел и символы _ . ( ) -, до 80 символов', kk: 'Файл аты: тек әріптер, сандар, бос орын және _ . ( ) - белгілері, 80 таңбаға дейін', en: 'File name: letters, digits, spaces and _ . ( ) - only, up to 80 characters' },
  empty: { ru: 'Пустой файл', kk: 'Бос файл', en: 'The file is empty' },
  too_big: { ru: 'Файл больше 2 МБ', kk: 'Файл 2 МБ-тан үлкен', en: 'The file is larger than 2 MB' },
  only_user: { ru: 'Удалять можно только загруженные файлы', kk: 'Тек жүктелген файлдарды жоюға болады', en: 'Only uploaded files can be deleted' },
  not_found: { ru: 'Файл не найден', kk: 'Файл табылмады', en: 'File not found' },
  too_many_files: { ru: 'Слишком много файлов: не больше {n}. Удалите ненужные.', kk: 'Файл тым көп: {n}-тен аспауы керек. Қажетсіздерін жойыңыз.', en: 'Too many files: the limit is {n}. Delete the ones you do not need.' },

  // аккаунты и база данных
  no_accounts: { ru: 'Аккаунты выключены: на сервере не подключена база данных', kk: 'Аккаунттар өшірулі: серверде дерекқор қосылмаған', en: 'Accounts are off: the server has no database connected' },
  db_down: { ru: 'База данных недоступна. Повторите через минуту.', kk: 'Дерекқор қолжетімсіз. Бір минуттан кейін қайталаңыз.', en: 'The database is unavailable. Try again in a minute.' },
  need_login: { ru: 'Войдите в аккаунт', kk: 'Аккаунтқа кіріңіз', en: 'Sign in to your account' },
  need_login_files: { ru: 'Войдите в аккаунт, чтобы загружать свои файлы', kk: 'Өз файлдарыңызды жүктеу үшін аккаунтқа кіріңіз', en: 'Sign in to upload your own files' },
  bad_email: { ru: 'Укажите корректный адрес почты', kk: 'Дұрыс пошта мекенжайын көрсетіңіз', en: 'Enter a valid email address' },
  bad_password: { ru: 'Пароль: от {min} символов', kk: 'Құпиясөз: кемінде {min} таңба', en: 'Password: at least {min} characters' },
  bad_name: { ru: 'Имя: до 80 символов', kk: 'Аты: 80 таңбаға дейін', en: 'Name: up to 80 characters' },
  email_taken: { ru: 'Аккаунт с такой почтой уже есть. Войдите.', kk: 'Мұндай поштамен аккаунт бар. Кіріңіз.', en: 'An account with this email already exists. Sign in.' },
  bad_login: { ru: 'Неверная почта или пароль', kk: 'Пошта немесе құпиясөз қате', en: 'Wrong email or password' },
  too_many_attempts: { ru: 'Слишком много попыток входа. Подождите {m} мин.', kk: 'Кіру әрекеті тым көп. {m} мин күтіңіз.', en: 'Too many sign-in attempts. Wait {m} min.' },
  need_verify: { ru: 'Подтвердите почту: мы отправили письмо со ссылкой на {email}', kk: 'Поштаны растаңыз: {email} мекенжайына сілтемесі бар хат жібердік', en: 'Confirm your email: we sent a link to {email}' },
  bad_token: { ru: 'Ссылка устарела или уже использована. Запросите новую.', kk: 'Сілтеме ескірген немесе қолданылған. Жаңасын сұраңыз.', en: 'The link has expired or was already used. Request a new one.' },
  no_mail: { ru: 'Отправка писем на сервере не настроена', kk: 'Серверде хат жіберу бапталмаған', en: 'Email sending is not configured on the server' },
  mail_failed: { ru: 'Не удалось отправить письмо. Повторите позже.', kk: 'Хат жіберілмеді. Кейінірек қайталаңыз.', en: 'Could not send the email. Try again later.' },
  oauth_off: { ru: 'Этот способ входа на сервере не настроен', kk: 'Бұл кіру тәсілі серверде бапталмаған', en: 'This sign-in method is not configured on the server' },
  oauth_cancel: { ru: 'Вход отменён', kk: 'Кіру тоқтатылды', en: 'Sign-in was cancelled' },
  oauth_state: { ru: 'Вход не завершён: начните его заново с этой страницы', kk: 'Кіру аяқталмады: осы беттен қайта бастаңыз', en: 'Sign-in was not completed: start again from this page' },
  oauth_failed: { ru: 'Не удалось войти через внешний сервис. Повторите позже.', kk: 'Сыртқы сервис арқылы кіру мүмкін болмады. Кейінірек қайталаңыз.', en: 'Could not sign in with the external service. Try again later.' },
  oauth_no_email: { ru: 'Сервис не передал адрес почты. Разрешите доступ к почте или войдите другим способом.', kk: 'Сервис пошта мекенжайын бермеді. Поштаға рұқсат беріңіз немесе басқа тәсілмен кіріңіз.', en: 'The service did not share an email address. Allow access to your email or sign in another way.' },
  oauth_email_taken: { ru: 'Аккаунт с этой почтой уже есть. Войдите по паролю или через Google.', kk: 'Бұл поштамен аккаунт бар. Құпиясөзбен немесе Google арқылы кіріңіз.', en: 'An account with this email already exists. Sign in with your password or with Google.' },

  // письма
  mail_verify_subject: { ru: 'KUCrop: подтвердите почту', kk: 'KUCrop: поштаны растаңыз', en: 'KUCrop: confirm your email' },
  mail_verify_text: { ru: 'Здравствуйте, {name}! Чтобы закончить регистрацию в KUCrop, подтвердите адрес почты. Ссылка действует {h} ч.', kk: 'Сәлеметсіз бе, {name}! KUCrop-та тіркелуді аяқтау үшін пошта мекенжайын растаңыз. Сілтеме {h} сағат жарамды.', en: 'Hello, {name}! To finish signing up for KUCrop, confirm your email address. The link is valid for {h} hours.' },
  mail_verify_button: { ru: 'Подтвердить почту', kk: 'Поштаны растау', en: 'Confirm email' },
  mail_reset_subject: { ru: 'KUCrop: сброс пароля', kk: 'KUCrop: құпиясөзді қалпына келтіру', en: 'KUCrop: password reset' },
  mail_reset_text: { ru: 'Здравствуйте, {name}! Для вашего аккаунта KUCrop запросили сброс пароля. Ссылка действует {m} мин.', kk: 'Сәлеметсіз бе, {name}! KUCrop аккаунтыңыз үшін құпиясөзді қалпына келтіру сұралды. Сілтеме {m} минут жарамды.', en: 'Hello, {name}! A password reset was requested for your KUCrop account. The link is valid for {m} minutes.' },
  mail_reset_button: { ru: 'Задать новый пароль', kk: 'Жаңа құпиясөз орнату', en: 'Set a new password' },
  mail_ignore: { ru: 'Если это были не вы, просто не открывайте ссылку.', kk: 'Егер бұл сіз болмасаңыз, сілтемені ашпаңыз.', en: 'If this was not you, just ignore this email.' },
  sim_not_found: { ru: 'Расчёт не найден', kk: 'Есеп табылмады', en: 'Calculation not found' },
  server_error: { ru: 'Ошибка сервера', kk: 'Сервер қатесі', en: 'Server error' },
};

const langOf = (req) => {
  const l = String((req.get && req.get('x-lang')) || (req.query && req.query.lang) || (req.body && req.body.lang) || 'ru').toLowerCase();
  return LANGS.includes(l) ? l : 'ru';
};

const msg = (lang, key, vars = {}) => (SM[key][lang] || SM[key].ru).replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));

/** Ошибка, текст которой безопасно показать пользователю: ключ сообщения или готовый текст (от Python). */
class HttpError extends Error {
  constructor(status, key, vars = {}, text = null) {
    super(text || key);
    this.status = status;
    this.key = text ? null : key;
    this.vars = vars;
    this.text = text;
  }
  static text(status, text) { return new HttpError(status, null, {}, text); }
  toText(lang) { return this.text || msg(lang, this.key, this.vars); }
}

module.exports = { SM, msg, langOf, HttpError };
