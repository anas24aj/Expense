"""Build data/merchants.json ({category: [brand names]}) for India and Saudi Arabia.

Sources, in priority order (the first category given to a name wins):
  1. CURATED below: apps, telcos, utilities, subscriptions, government and the SMS descriptor forms banks print.
  2. OpenStreetMap name-suggestion-index (BSD-3-Clause, https://github.com/osmlab/name-suggestion-index):
     brands whose locationSet includes India ("in", "in-*"), Saudi Arabia ("sa", "sa-*") or the whole world ("001"),
     mapped from their OSM tag (shop=supermarket → Groceries, amenity=fuel → Transport, ...).

Usage:  python3 scripts/build_merchants.py [path/to/nsi.json]
Without a path it downloads the npm package (registry.npmjs.org) into a temporary folder.
Category names are the ones rules.json uses, so learned corrections and the dashboard keep working.
"""
import io
import json
import re
import sys
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'data' / 'merchants.json'

CURATED = {
    'Fees & interest': [
        'finance charges', 'finance charge', 'interest charges', 'card interest', 'late payment fee', 'late fee',
        'annual fee', 'annual membership fee', 'membership fee', 'joining fee', 'renewal fee', 'overlimit fee',
        'cash advance fee', 'forex markup', 'markup fee', 'bank charges', 'sms charges', 'sms alert charges',
        'service charges', 'gst on charges', 'igst', 'cgst', 'sgst', 'penal charges', 'bounce charges',
        'processing fee', 'رسوم سنوية', 'رسوم تأخير', 'غرامة تأخير', 'رسوم خدمة',
    ],
    'Groceries': [
        'bigbasket', 'bb now', 'blinkit', 'grofers', 'zepto', 'swiggy instamart', 'instamart', 'jiomart', 'dmart',
        'avenue supermarts', 'dmart ready', 'reliance smart', 'reliance retail', 'smart bazaar', 'reliance fresh',
        'more retail', 'more megastore', 'spencers', 'spencers retail', 'natures basket', 'star bazaar', 'big bazaar',
        'easyday', 'vishal mega mart', 'ratnadeep', 'heritage fresh', 'nilgiris', 'licious', 'freshtohome',
        'country delight', 'milkbasket', 'amazon fresh', 'flipkart minutes', 'flipkart supermart', 'dunzo daily',
        'nesto', 'lulu hypermarket', 'lulu', 'carrefour', 'hyperpanda', 'panda', 'panda retail', 'tamimi markets',
        'tamimi', 'danube', 'bindawood', 'bin dawood', 'othaim', 'othaim markets', 'al othaim', 'al raya',
        'farm superstores', 'manuel market', 'nana', 'nana direct', 'ninja', 'ninja retail', 'sadhan', 'al sadhan',
        'grand hyper', 'hyper al wafa', 'al wafa', 'aswaq al muntazah', 'muntazah', 'spar', 'geant', 'mark and save',
        'markaz al ain', 'lulu express', 'nesto hypermarket', 'tamimi markets', 'zad', 'al jazera supermarket',
        'بنده', 'هايبر بنده', 'التميمي', 'العثيم', 'أسواق العثيم', 'الدانوب', 'كارفور', 'لولو', 'بن داود',
        'المزرعة', 'السدحان', 'نينجا', 'نعناع',
    ],
    'Food': [
        'swiggy', 'zomato', 'zomato ltd', 'eternal', 'eatsure', 'rebel foods', 'faasos', 'behrouz', 'box8', 'freshmenu',
        'magicpin', 'dominos', 'dominos pizza', 'jubilant foodworks', 'pizza hut', 'kfc', 'mcdonalds',
        'hardcastle restaurants', 'burger king', 'subway', 'starbucks', 'tata starbucks', 'cafe coffee day', 'ccd',
        'third wave coffee', 'blue tokai', 'chaayos', 'chai point', 'haldirams', 'bikanervala', 'barbeque nation',
        'wow momo', 'theobroma', 'baskin robbins', 'naturals ice cream', 'keventers', 'mainland china',
        'paradise biryani', 'saravana bhavan', 'a2b', 'adyar ananda bhavan', 'mtr', 'vaango', 'goli vada pav',
        'jahez', 'hungerstation', 'hunger station', 'talabat', 'keeta', 'mrsool', 'the chefz', 'chefz', 'toyou',
        'careem food', 'noon food', 'shgardi', 'nana food', 'albaik', 'al baik', 'kudu', 'herfy', 'shawarmer',
        'maestro pizza', 'al tazaj', 'altazaj', 'tazaj', 'al romansiah', 'romansiah', 'mama noura', 'kabab ji',
        'barns', 'half million', 'dose cafe', 'dr cafe', 'overdose', 'brew92', 'camel step', 'elixir bunn',
        'tim hortons', 'caribou', 'caribou coffee', 'dunkin', 'dunkin donuts', 'costa', 'costa coffee', 'krispy kreme',
        'shake shack', 'five guys', 'hardees', 'papa johns', 'little caesars', 'texas chicken', 'popeyes', 'wingstop',
        'applebees', 'chilis', 'ihop', 'nandos', 'jollibee', 'cinnabon', 'joffreys', 'urth caffe', 'starbucks coffee',
        'section b', 'brew', 'saudi coffee', 'coffee address', 'ستاربكس', 'البيك', 'كودو', 'هرفي', 'هنقرستيشن',
        'جاهز', 'مرسول', 'كيتا', 'طلبات', 'ماكدونالدز', 'دانكن', 'تيم هورتنز', 'بارنز', 'هاف مليون', 'الطازج',
        'الرومانسية', 'شاورمر',
    ],
    'Shopping': [
        'amazon', 'amazon pay', 'amazon seller services', 'amazon india', 'amzn', 'flipkart', 'flipkart internet',
        'myntra', 'ajio', 'meesho', 'nykaa', 'nykaa fashion', 'tata cliq', 'tatacliq', 'croma', 'reliance digital',
        'vijay sales', 'snapdeal', 'firstcry', 'lenskart', 'pepperfry', 'urban ladder', 'decathlon', 'ikea',
        'westside', 'trent', 'zudio', 'pantaloons', 'lifestyle', 'shoppers stop', 'max fashion', 'max', 'fabindia',
        'bata', 'tanishq', 'kalyan jewellers', 'malabar gold', 'joyalukkas', 'titan', 'apple store',
        'samsung', 'xiaomi', 'mi store', 'oneplus', 'noon', 'noon com', 'noon minutes', 'namshi', 'shein', 'jarir',
        'jarir bookstore', 'extra', 'extra stores', 'united electronics', 'saco', 'abyat', 'centrepoint',
        'home centre', 'home box', 'babyshop', 'splash', 'redtag', 'red tag', 'aldo', 'adidas', 'nike', 'puma',
        'sun and sand sports', 'zara', 'h m', 'hm', 'mango', 'bershka', 'pull bear', 'massimo dutti', 'american eagle',
        'centrepoint', 'virgin megastore', 'sephora', 'faces', 'bath and body works', 'the body shop', 'arabian oud',
        'abdul samad al qurashi', 'ajmal', 'rasasi', 'swiss arabian', 'tamara', 'tabby', 'temu', 'aliexpress',
        'alibaba', 'trendyol', 'iherb', 'ebay', 'etsy', 'sivvi', 'ounass', 'mumzworld', 'toys r us', 'danube home',
        'ace hardware', 'jumbo electronics', 'sharaf dg', 'lc waikiki', 'defacto', 'nahdi online',
        'نون', 'جرير', 'مكتبة جرير', 'اكسترا', 'أمازون', 'امازون', 'نمشي', 'شي ان', 'ايكيا', 'سنتربوينت',
        'العربية للعود', 'عبدالصمد القرشي',
    ],
    'Transport': [
        'uber', 'uber india', 'uber bv', 'ola', 'olacabs', 'ola cabs', 'ani technologies', 'rapido', 'roppen',
        'blusmart', 'meru', 'namma yatri', 'yulu', 'bounce', 'irctc', 'irctc utsonline', 'indian railways', 'metro',
        'delhi metro', 'dmrc', 'bmrcl', 'namma metro', 'mumbai metro', 'hyderabad metro', 'chennai metro',
        'fastag', 'netc fastag', 'paytm fastag', 'nhai', 'indian oil', 'iocl', 'bpcl', 'bharat petroleum', 'hpcl',
        'hindustan petroleum', 'nayara', 'nayara energy', 'shell', 'jio bp', 'reliance bp', 'essar', 'parkplus',
        'park plus', 'cars24', 'spinny', 'zoomcar', 'revv', 'redbus', 'abhibus', 'careem', 'bolt', 'jeeny', 'kaiian',
        'kayan', 'uber saudi', 'aldrees', 'al drees', 'sasco', 'petromin', 'naft', 'aramco', 'saudi aramco',
        'total energies', 'totalenergies', 'adnoc', 'mobil', 'gasoline', 'saptco', 'riyadh bus', 'riyadh metro',
        'darb', 'saudi railway', 'saudi railways', 'haramain', 'haramain train', 'mawqif', 'mawgif', 'yelo',
        'theeb', 'lumi', 'hertz', 'avis', 'europcar', 'key car rental', 'hanco', 'ejada', 'salik',
        'petrol', 'tyre plus', 'autozone', 'mufaddal', 'الدريس', 'ساسكو', 'بترومين', 'نفط', 'أرامكو',
        'ارامكو', 'أوبر', 'اوبر', 'كريم', 'بولت', 'سابتكو', 'قطار الحرمين', 'الخطوط الحديدية', 'موقف', 'يلو', 'ذيب',
    ],
    'Travel': [
        'makemytrip', 'mmt', 'goibibo', 'cleartrip', 'yatra', 'ixigo', 'easemytrip', 'thomas cook', 'sotc', 'oyo',
        'oyo rooms', 'treebo', 'fabhotels', 'taj hotels', 'ihcl', 'itc hotels', 'oberoi', 'lemon tree',
        'indigo', 'interglobe aviation', 'air india', 'air india express', 'vistara', 'akasa', 'akasa air', 'spicejet',
        'go first', 'alliance air', 'saudia', 'saudi airlines', 'saudi arabian airlines', 'flynas', 'flyadeal',
        'riyadh air', 'almosafer', 'flyin', 'tajawal', 'wego', 'rehlat', 'booking com', 'booking', 'agoda', 'airbnb',
        'expedia', 'trip com', 'hotels com', 'kayak', 'skyscanner', 'emirates', 'qatar airways', 'etihad', 'flydubai',
        'air arabia', 'gulf air', 'oman air', 'kuwait airways', 'jazeera airways', 'turkish airlines', 'egyptair',
        'lufthansa', 'british airways', 'singapore airlines', 'marriott', 'hilton', 'hyatt', 'radisson', 'accor',
        'novotel', 'ibis', 'holiday inn', 'crowne plaza', 'ihg', 'movenpick', 'rotana', 'four seasons', 'ritz carlton',
        'sheraton', 'westin', 'le meridien', 'intercontinental', 'swissotel', 'fairmont', 'dur hospitality',
        'boudl', 'gathern', 'jumeirah', 'visa vfs', 'vfs global', 'bls international', 'tasheer',
        'السعودية', 'الخطوط السعودية', 'طيران ناس', 'ناس', 'طيران أديل', 'المسافر', 'فلاي إن', 'بودل', 'جاذر إن',
    ],
    'Bills & Utilities': [
        'airtel', 'bharti airtel', 'airtel payments', 'jio', 'reliance jio', 'jio prepaid', 'jiorecharge', 'jio recharge', 'airtelrecharge', 'airtel recharge', 'vi recharge', 'jiofiber', 'vi',
        'vodafone idea', 'vodafone', 'idea', 'bsnl', 'mtnl', 'act fibernet', 'hathway', 'excitel', 'you broadband',
        'tata play', 'tata sky', 'dish tv', 'd2h', 'sun direct', 'airtel dth', 'bescom', 'kseb', 'mseb', 'msedcl',
        'mahadiscom', 'tata power', 'tata power ddl', 'adani electricity', 'bses', 'bses rajdhani', 'bses yamuna',
        'tneb', 'tangedco', 'tnpdcl', 'tsspdcl', 'apspdcl', 'cesc', 'uppcl', 'pspcl', 'wbsedcl', 'torrent power',
        'jvvnl', 'mgvcl', 'dgvcl', 'pgvcl', 'ugvcl', 'cesc limited', 'bwssb', 'delhi jal board', 'djb', 'mcgm',
        'mahanagar gas', 'igl', 'indraprastha gas', 'gujarat gas', 'adani gas', 'indane', 'bharat gas', 'hp gas',
        'bbps', 'billdesk', 'stc', 'saudi telecom', 'stc bill', 'mobily', 'etihad etisalat', 'zain', 'zain ksa',
        'salam', 'salam mobile', 'virgin mobile', 'lebara', 'redbull mobile', 'friendi', 'go telecom', 'jawwy',
        'sawa', 'saudi electricity', 'sec', 'saudi electricity company', 'nwc', 'national water company',
        'marafiq', 'tawzea', 'sadad', 'sadad bill', 'gas cylinder', 'gasco',
        'الاتصالات السعودية', 'اس تي سي', 'موبايلي', 'زين', 'سلام', 'ليبارا', 'فيرجن', 'جوي', 'سوا',
        'الشركة السعودية للكهرباء', 'السعودية للكهرباء', 'شركة المياه الوطنية', 'المياه الوطنية', 'مرافق', 'سداد',
    ],
    'Subscriptions': [
        'netflix', 'netflix com', 'spotify', 'youtube', 'youtube premium', 'youtubepremium', 'google youtube',
        'google play', 'google one', 'google storage', 'google workspace', 'gsuite', 'apple com',
        'apple com bill', 'itunes', 'icloud', 'apple music', 'apple tv', 'apple one', 'amazon prime', 'prime video',
        'primevideo', 'amazon digital', 'audible', 'kindle', 'disney', 'disney plus', 'hotstar', 'disney hotstar',
        'jiohotstar', 'jiocinema', 'sonyliv', 'zee5', 'altbalaji', 'voot', 'mx player', 'sun nxt',
        'hoichoi', 'gaana', 'jiosaavn', 'wynk', 'shahid', 'shahid vip', 'mbc shahid', 'osn', 'osn plus', 'osnplus',
        'starzplay', 'starz play', 'tod', 'tod tv', 'anghami', 'deezer', 'stc tv', 'jawwy tv', 'weyyak', 'yango play',
        'anthropic', 'claude', 'claude ai', 'openai', 'chatgpt', 'chatgpt subscription', 'perplexity', 'midjourney',
        'github', 'microsoft', 'microsoft 365', 'office 365', 'msft', 'xbox', 'xbox game pass', 'playstation',
        'playstation network', 'psn', 'sony playstation', 'steam', 'steampowered', 'nintendo', 'epic games',
        'canva', 'adobe', 'dropbox', 'notion', 'zoom', 'zoom us', 'slack', 'linkedin', 'patreon', 'duolingo', 'headspace', 'calm', 'tinder', 'bumble', 'times prime', 'zomato gold', 'swiggy one',
        'cult fit', 'cultfit', 'nordvpn', 'expressvpn', 'grammarly', 'evernote', '1password', 'lastpass',
        'نتفليكس', 'شاهد', 'أنغامي', 'انغامي', 'اشتراك',
    ],
    'Health': [
        'apollo', 'apollo pharmacy', 'apollo hospitals', 'apollo 247', 'medplus', 'pharmeasy', 'tata 1mg', '1mg',
        'netmeds', 'truemeds', 'practo', 'fortis', 'max healthcare', 'manipal hospitals', 'narayana health',
        'aster', 'aster dm', 'kims', 'medanta', 'aiims', 'dr lal pathlabs', 'lal pathlabs', 'metropolis',
        'thyrocare', 'healthians', 'redcliffe', 'cult', 'nahdi', 'al nahdi', 'nahdi medical', 'al dawaa', 'dawaa',
        'whites pharmacy', 'united pharmacy', 'lemon pharmacy', 'orange pharmacy', 'boots', 'sulaiman al habib',
        'dr sulaiman al habib', 'hmg', 'mouwasat', 'dallah', 'dallah hospital', 'saudi german hospital',
        'kingdom hospital', 'al mana', 'magrabi', 'al borg', 'albor', 'seha', 'sehhaty', 'vezeeta', 'cura', 'fitness time', 'leejam', 'body masters', 'gold gym', 'golds gym', 'fitness first',
        'armah', 'nuyu', 'وقت اللياقة', 'النهدي', 'صيدلية النهدي', 'الدواء', 'صيدلية الدواء', 'الحبيب',
        'د سليمان الحبيب', 'المواساة', 'دله', 'المستشفى السعودي الألماني', 'البرج',
    ],
    'Entertainment': [
        'bookmyshow', 'bigtree', 'pvr', 'pvr inox', 'inox', 'cinepolis', 'district', 'paytm insider', 'insider',
        'zomato district', 'wonderla', 'imagicaa', 'smaaash', 'timezone', 'vox', 'vox cinemas', 'muvi', 'muvi cinemas',
        'amc', 'amc cinemas', 'empire cinemas', 'reel cinemas', 'webook', 'we book', 'ticketmax', 'platinumlist',
        'boulevard riyadh', 'riyadh season', 'jeddah season', 'sparkys', 'snow city', 'six flags', 'qiddiya',
        'via riyadh', 'diriyah', 'al hokair', 'hokair', 'ftz', 'dream11', 'mpl', 'my11circle',
        'ووي بوك', 'موسم الرياض', 'موسم جدة', 'فوكس', 'موفي', 'الحكير',
    ],
    'Rent & EMI': [
        'nobroker', 'nestaway', 'housing com', 'magicbricks', 'ejar', 'إيجار', 'rentpay', 'red sea rent',
        'bajaj finance', 'bajaj finserv', 'home credit', 'tata capital', 'hdb financial', 'muthoot', 'manappuram',
        'emi', 'loan emi', 'nach emi', 'sakani', 'سكني', ],
    'Investments': [
        'zerodha', 'groww', 'upstox', 'angel one', 'angel broking', 'icici direct', 'icicidirect', 'hdfc securities',
        'kotak securities', 'sharekhan', 'motilal oswal', '5paisa', 'paytm money', 'indmoney', 'etmoney', 'kuvera',
        'smallcase', 'coin by zerodha', 'cams', 'kfintech', 'bse star mf', 'nse clearing', 'iccl', 'nps trust',
        'ppf', 'sip', 'mutual fund', 'derayah', 'tadawul', 'sahm', 'thndr', 'al rajhi capital', 'alrajhi capital',
        'snb capital', 'riyad capital', 'aljazira capital', 'alinma investment', 'sab invest', 'yaqeen capital',
        'abyan capital', 'wahed', 'binance', 'coinbase', 'wazirx', 'coindcx', 'safegold', 'augmont',
        'دراية', 'تداول', 'الراجحي المالية', 'ثندر', 'سهم',
    ],
    'Insurance': [
        'lic', 'lic of india', 'life insurance corporation', 'policybazaar', 'acko', 'digit insurance', 'go digit',
        'hdfc life', 'hdfc ergo', 'icici prudential', 'icici lombard', 'sbi life', 'sbi general', 'max life',
        'axis max life', 'tata aig', 'tata aia', 'bajaj allianz', 'star health', 'niva bupa', 'care health',
        'aditya birla health', 'kotak life', 'new india assurance', 'united india insurance', 'oriental insurance',
        'tawuniya', 'bupa', 'bupa arabia', 'medgulf', 'walaa', 'malath', 'al rajhi takaful', 'salama', 'axa', 'allianz saudi fransi', 'tameeni', 'tree insurance', 'najm', 'saico', 'buruj', 'wataniya',
        'التعاونية', 'بوبا', 'ملاذ', 'ولاء', 'تكافل الراجحي', 'تأميني',
    ],
    'Cash': ['atm', 'atm wdl', 'atm withdrawal', 'cash withdrawal', 'nfs atm', 'cardless cash', 'صراف آلي', 'سحب نقدي'],
    'Personal care': [
        'urban company', 'urbanclap', 'lakme salon', 'naturals salon', 'enrich salon', 'jawed habib', 'looks salon',
        'vlcc', 'kaya', 'bodycraft', 'tonic', 'tonic salon', 'barberz', 'king barber', 'washmen', 'laundry',
        'dhobilite', 'pressto', 'mughal laundry', 'صالون', 'حلاق', 'مغسلة',
    ],
    'Education': [
        'byjus', 'unacademy', 'vedantu', 'physicswallah', 'upgrad', 'simplilearn', 'great learning',
        'scaler', 'coursera', 'udemy', 'edx', 'skillshare', 'masterclass', 'brilliant', 'khan academy',
        'cbse', 'cbse fees', 'school fees', 'college fees', 'tuition fees', 'noon academy',
        'madrasati', 'classera', 'ministry of education', 'وزارة التعليم', 'مدرستي', 'جامعة', 'مدارس',
    ],
    'Government & fees': [
        'absher', 'abshr', 'moi', 'ministry of interior', 'jawazat', 'passport', 'iqama', 'iqama renewal', 'muqeem',
        'saher', 'traffic violation', 'najiz', 'balady', 'baladiya', 'zatca', 'gosi', 'qiwa', 'musaned', 'mudad',
        'enjaz', 'exit re entry', 'exit reentry', 'nafath', 'tawakkalna', 'mofa', 'efaa', 'ministry of justice',
        'saudi customs', 'customs', 'passport seva', 'passportindia', 'income tax', 'incometax', 'tin nsdl', 'nsdl',
        'utiitsl', 'gst', 'gstn', 'challan', 'e challan', 'echallan', 'parivahan', 'rto', 'traffic police',
        'municipal corporation', 'property tax', 'bbmp', 'ghmc', 'mcgm', 'mcd', 'uidai', 'aadhaar', 'digilocker',
        'indian embassy', 'embassy of india', 'cgi jeddah', 'vfs', 'أبشر', 'ابشر', 'الجوازات', 'وزارة الداخلية',
        'مقيم', 'إقامة', 'اقامة', 'ساهر', 'ناجز', 'بلدي', 'الزكاة والضريبة', 'التأمينات الاجتماعية', 'قوى', 'مساند',
        'مدد', 'خروج وعودة', 'المرور', 'الجمارك',
    ],
    'Charity': [
        'ehsan', 'ehsan platform', 'sadaqa', 'zakat', 'zakat al fitr', 'king salman relief', 'ksrelief', 'red crescent',
        'saudi red crescent', 'masjid', 'mosque', 'pm cares', 'akshaya patra', 'give india', 'giveindia', 'unicef', 'ketto', 'milaap', 'goonj', 'helpage', 'إحسان', 'احسان', 'منصة إحسان', 'زكاة', 'صدقة', 'جود',
        'الهلال الأحمر', 'مركز الملك سلمان للإغاثة', 'تبرع',
    ],
}

# OSM tag (after 'brands/') → our category. Anything not listed (banks, ATMs, money transfer, offices) is left out:
# a bank's name in an SMS is the bank, not what was bought.
TAGS = {
    'Groceries': ['shop/supermarket', 'shop/convenience', 'shop/greengrocer', 'shop/butcher', 'shop/dairy', 'shop/deli',
                  'shop/frozen_food', 'shop/seafood', 'shop/wholesale', 'shop/health_food', 'shop/spices', 'shop/food',
                  'shop/water'],
    'Food': ['amenity/fast_food', 'amenity/restaurant', 'amenity/cafe', 'amenity/ice_cream', 'amenity/food_court',
             'amenity/bar', 'amenity/pub', 'shop/bakery', 'shop/pastry', 'shop/confectionery', 'shop/coffee',
             'shop/tea', 'shop/chocolate', 'shop/beverages'],
    'Transport': ['amenity/fuel', 'amenity/charging_station', 'amenity/car_wash', 'amenity/car_rental',
                  'amenity/parking', 'amenity/bicycle_rental', 'amenity/motorcycle_rental', 'amenity/taxi',
                  'shop/car_repair', 'shop/tyres', 'shop/car_parts', 'shop/car', 'shop/motorcycle',
                  'shop/motorcycle_repair', 'shop/gas'],
    'Health': ['amenity/pharmacy', 'amenity/clinic', 'amenity/hospital', 'amenity/dentist', 'amenity/doctors',
               'healthcare/laboratory', 'healthcare/clinic', 'healthcare/hospital', 'healthcare/pharmacy',
               'healthcare/optometrist', 'shop/medical_supply', 'shop/chemist', 'leisure/fitness_centre',
               'leisure/sports_centre'],
    'Shopping': ['shop/clothes', 'shop/shoes', 'shop/electronics', 'shop/mobile_phone', 'shop/jewelry', 'shop/watches',
                 'shop/cosmetics', 'shop/perfumery', 'shop/furniture', 'shop/houseware', 'shop/doityourself',
                 'shop/hardware', 'shop/department_store', 'shop/mall', 'shop/sports', 'shop/toys', 'shop/books',
                 'shop/stationery', 'shop/gift', 'shop/variety_store', 'shop/bag', 'shop/fashion_accessories',
                 'shop/computer', 'shop/hifi', 'shop/appliance', 'shop/baby_goods', 'shop/optician', 'shop/kitchen',
                 'shop/paint', 'shop/bed', 'shop/interior_decoration', 'shop/pet', 'shop/florist', 'shop/outdoor',
                 'shop/fabric', 'shop/lighting', 'shop/bathroom_furnishing', 'shop/carpet', 'shop/garden_centre',
                 'shop/craft', 'shop/music', 'shop/video_games', 'shop/photo', 'shop/second_hand', 'shop/tiles',
                 'shop/trade', 'shop/eyewear'],
    'Personal care': ['shop/hairdresser', 'shop/beauty', 'shop/laundry', 'shop/dry_cleaning', 'shop/massage',
                      'shop/tailor', 'amenity/spa', 'leisure/spa'],
    'Travel': ['tourism/hotel', 'tourism/motel', 'tourism/guest_house', 'tourism/apartment', 'tourism/hostel',
               'tourism/resort', 'shop/travel_agency'],
    'Entertainment': ['amenity/cinema', 'amenity/theatre', 'leisure/amusement_arcade', 'leisure/bowling_alley',
                      'leisure/water_park', 'tourism/theme_park', 'leisure/trampoline_park'],
    'Insurance': ['office/insurance'],
    'Education': ['amenity/school', 'amenity/college', 'amenity/university', 'amenity/kindergarten',
                  'amenity/language_school', 'amenity/driving_school', 'amenity/prep_school', 'office/educational_institution'],
    'Bills & Utilities': ['shop/telecommunication', 'office/telecommunication'],
}
TAG_CATEGORY = {tag: category for category, tags in TAGS.items() for tag in tags}
# Global brands whose name is an everyday word or a person's name: as a merchant prefix they'd misfile too much.
TOO_GENERIC = set('''bank express life gap next boss guess coach total ace star king best city one fresh smart family
super market mart store shop food cafe coffee pizza burger grill home style beauty care plus central metro target
first golden royal prime green blue red sun moon crown point united national global international new the
continental elite classic modern trends fashion avenue jet circle k lucky happy daily day night good bon nova orange
apple diamond pearl unique alpha delta omega sky ocean palm max more spar arena center centre plaza galaxy
lotus rose jasmine sunny sara ali omar ahmed mohammed muhammad abdullah ram sri shri ganesh lakshmi krishna sai
balaji om empire hell paul sonic quickly tortilla figaro checkers persona picture pink expert liberty garage globus
helios humana champion emma roots orchestra typo reserved subdued discovery defender genesis alliance loop wash
reliance tata marathon mini seat safeway payless hampton courtyard conrad millennium renaissance gulf messer
enterprise midas lucid polaris triumph dynamite budget only bench hero mikel'''.split())
SCRIPTS = re.compile(r'^[a-z0-9 \u00c0-\u024f\u0600-\u06ff\u0900-\u097f]+$')  # Latin, Arabic, Devanagari
LOCATION = re.compile(r'^(?:in|sa)(?:-|$)|^001$')


def wanted(location_set):
    inc = [str(x).lower() for x in location_set.get('include', [])]
    exc = [str(x).lower() for x in location_set.get('exclude', [])]
    return any(LOCATION.match(x) for x in inc) and not any(x in ('in', 'sa') for x in exc)


def from_nsi(nsi):
    found = {}
    for path, group in nsi['nsi'].items():
        category = path.startswith('brands/') and TAG_CATEGORY.get(path[len('brands/'):])
        if not category:
            continue
        for item in group['items']:
            if not wanted(item.get('locationSet', {})):
                continue
            tags = item.get('tags', {})
            names = {item.get('displayName', ''), tags.get('brand', ''), tags.get('name', '')}
            names |= {v for k, v in tags.items() if k.startswith(('brand:', 'name:')) and k.split(':')[1] in ('en', 'ar', 'hi')}
            for name in names:
                name = name.strip()
                key = re.sub(r'[^\w]+', ' ', name.lower().replace("'", '').replace('’', '')).strip()
                # one word needs 4+ letters ('EVA', 'ELS' would prefix-match too much); only scripts SMS are written in.
                if (len(key) >= 4 or ' ' in key) and key not in TOO_GENERIC and SCRIPTS.match(key):
                    found.setdefault(name, category)
    return found


def load_nsi(path=None):
    if path:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    meta = json.load(urllib.request.urlopen('https://registry.npmjs.org/name-suggestion-index/latest', timeout=60))
    blob = urllib.request.urlopen(meta['dist']['tarball'], timeout=300).read()
    with tarfile.open(fileobj=io.BytesIO(blob)) as tar:
        return json.load(tar.extractfile('package/dist/json/nsi.json'))


def build(nsi):
    out = {category: list(dict.fromkeys(names)) for category, names in CURATED.items()}
    known = {n.lower() for names in CURATED.values() for n in names}
    for name, category in sorted(from_nsi(nsi).items()):
        if name.lower() not in known:
            known.add(name.lower())
            out.setdefault(category, []).append(name)
    return out


if __name__ == '__main__':
    nsi = load_nsi(sys.argv[1] if len(sys.argv) > 1 else None)
    data = build(nsi)
    data = {'_source': 'Curated + OpenStreetMap name-suggestion-index ' + nsi.get('_meta', {}).get('version', '?')
                       + ' (BSD-3-Clause). Rebuild: python3 scripts/build_merchants.py', **data}
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=0, separators=(',', ':')) + '\n', encoding='utf-8')
    print(f'{OUT}: {sum(len(v) for k, v in data.items() if k != "_source")} names, {OUT.stat().st_size} bytes')
