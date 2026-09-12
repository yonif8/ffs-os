#!/usr/bin/env python3
"""Generate a dependency-free Xcode app project; uses Android's existing vendored LC3 sources."""
import hashlib
import json
import plistlib
import sys
MAC = "--mac" in sys.argv
NAME = "FFSBridgeMac" if MAC else "FFSBridge"
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'FFSBridge'
LC3 = ROOT.parent / 'modules/ffs-ble/android/src/main/cpp/third_party/liblc3'
objects = {}
def uid(s): return hashlib.sha256(s.encode()).hexdigest()[:24].upper()
def obj(identity, **fields):
    key = uid(identity); objects[key] = fields; return key

def plist(v, depth=0):
    if isinstance(v, dict): return '{\n' + ''.join('\t'*(depth+1)+json.dumps(k)+' = '+plist(val, depth+1)+';\n' for k,val in v.items()) + '\t'*depth+'}'
    if isinstance(v, list): return '(\n' + ''.join('\t'*(depth+1)+plist(i,depth+1)+',\n' for i in v)+'\t'*depth+')'
    return json.dumps(str(v))

files = sorted(APP.rglob('*.swift')) + sorted(APP.rglob('*.c'))
files = [f for f in files if ('MacUI' not in f.parts if not MAC else 'UI' not in f.parts)]
files += [LC3/'liblc3'/f'{n}.c' for n in ['attdet','bits','bwdet','energy','lc3','ltpf','mdct','plc','sns','spec','tables','tns']]
refs, builds = [], []
for file in files:
    path = str(file.relative_to(ROOT)) if file.is_relative_to(ROOT) else '../'+str(file.relative_to(ROOT.parent))
    ref = obj(path, isa='PBXFileReference', lastKnownFileType='sourcecode.swift' if file.suffix=='.swift' else 'sourcecode.c.c', path=path, sourceTree='<group>')
    refs.append(ref); builds.append(obj('build:'+path, isa='PBXBuildFile', fileRef=ref))
product=obj('product', isa='PBXFileReference', explicitFileType='wrapper.application', path=NAME+'.app', sourceTree='BUILT_PRODUCTS_DIR')
products=obj('products', isa='PBXGroup', children=[product], name='Products', sourceTree='<group>')
main=obj('main', isa='PBXGroup', children=refs+[products], sourceTree='<group>')
sources=obj('sources', isa='PBXSourcesBuildPhase', buildActionMask=2147483647, files=builds, runOnlyForDeploymentPostprocessing=0)
frameworks=obj('frameworks', isa='PBXFrameworksBuildPhase', buildActionMask=2147483647, files=[], runOnlyForDeploymentPostprocessing=0)
seed_builds = []
for file in ([] if '--no-local-seeds' in sys.argv else sorted((APP/'SeedApps.local').glob('*.ffsa'))):
    path = str(file.relative_to(ROOT))
    ref = obj(path, isa='PBXFileReference', lastKnownFileType='file', path=path, sourceTree='<group>')
    refs.append(ref)
    seed_builds.append(obj('build:'+path, isa='PBXBuildFile', fileRef=ref))
resources=obj('resources', isa='PBXResourcesBuildPhase', buildActionMask=2147483647, files=seed_builds, runOnlyForDeploymentPostprocessing=0)
base={'SDKROOT':'iphoneos','IPHONEOS_DEPLOYMENT_TARGET':'17.0','SWIFT_VERSION':'5.0','CLANG_ENABLE_MODULES':'YES','CLANG_ENABLE_OBJC_ARC':'YES','GCC_C_LANGUAGE_STANDARD':'gnu11','GCC_OPTIMIZATION_LEVEL':'3','ENABLE_USER_SCRIPT_SANDBOXING':'YES'}
target={'PRODUCT_BUNDLE_IDENTIFIER':'com.futurefounders.ffsbridge','PRODUCT_NAME':'$(TARGET_NAME)','CODE_SIGN_STYLE':'Automatic','TARGETED_DEVICE_FAMILY':'1','INFOPLIST_FILE':'FFSBridge/Info.plist','SWIFT_OBJC_BRIDGING_HEADER':'FFSBridge/Core/LC3Bridge.h','HEADER_SEARCH_PATHS':['$(inherited)','$(SRCROOT)/../modules/ffs-ble/android/src/main/cpp/third_party/liblc3/include','$(SRCROOT)/../modules/ffs-ble/android/src/main/cpp/third_party/liblc3/liblc3'],'OTHER_LDFLAGS':['$(inherited)','-lsqlite3'],'SUPPORTED_PLATFORMS':'iphoneos iphonesimulator','SUPPORTS_MACCATALYST':'NO','MARKETING_VERSION':'1.0','CURRENT_PROJECT_VERSION':'1','ENABLE_APP_INTENTS_METADATA_EXTRACTION':'NO'}
if MAC:
    base.pop('IPHONEOS_DEPLOYMENT_TARGET')
    base.update(SDKROOT='macosx', MACOSX_DEPLOYMENT_TARGET='14.0')
    target.pop('TARGETED_DEVICE_FAMILY')
    target.update(PRODUCT_BUNDLE_IDENTIFIER='com.futurefounders.ffsbridge.mac', INFOPLIST_FILE='FFSBridge/InfoMac.plist', SUPPORTED_PLATFORMS='macosx', ENABLE_HARDENED_RUNTIME='YES', ENABLE_APP_SANDBOX='NO')
    # Leave signing to Signing.xcconfig (which #includes the untracked Signing.local.xcconfig): a
    # target-level setting would override the xcconfig and force ad-hoc every build, which changes the
    # code hash each rebuild so macOS re-prompts for Bluetooth (TCC keys on the cdhash for ad-hoc).
    # Signing.xcconfig carries a macosx-scoped ad-hoc default; a stable identity in the local file wins.
    for k in ('CODE_SIGN_STYLE', 'CODE_SIGN_IDENTITY', 'DEVELOPMENT_TEAM'):
        target.pop(k, None)
signing = obj('signing', isa='PBXFileReference', lastKnownFileType='text.xcconfig', path='Signing.xcconfig', sourceTree='<group>')
objects[main]['children'].insert(0, signing)
def configurations(name, settings):
    configs=[]
    for mode in ['Debug','Release']:
        cfg=dict(settings); cfg['SWIFT_OPTIMIZATION_LEVEL']='-Onone' if mode=='Debug' else '-O'
        if mode=='Debug': cfg['SWIFT_ACTIVE_COMPILATION_CONDITIONS']='DEBUG'
        configs.append(obj(name+mode,isa='XCBuildConfiguration',name=mode,buildSettings=cfg,baseConfigurationReference=signing))
    return obj(name+'configs',isa='XCConfigurationList',buildConfigurations=configs,defaultConfigurationIsVisible=0,defaultConfigurationName='Debug')
pc=configurations('project',base); tc=configurations('target',target)
tid=obj('target',isa='PBXNativeTarget',buildConfigurationList=tc,buildPhases=[sources,frameworks,resources],buildRules=[],dependencies=[],name=NAME,productName=NAME,productReference=product,productType='com.apple.product-type.application')
pid=obj('project',isa='PBXProject',attributes={'BuildIndependentTargetsInParallel':'YES','LastUpgradeCheck':'2600'},buildConfigurationList=pc,compatibilityVersion='Xcode 14.0',developmentRegion='en',hasScannedForEncodings=0,knownRegions=['en','Base'],mainGroup=main,productRefGroup=products,projectDirPath='',projectRoot='',targets=[tid])
project=ROOT/(NAME+'.xcodeproj'); project.mkdir(exist_ok=True)
(project/'project.pbxproj').write_text('// !$*UTF8*$!\n'+plist({'archiveVersion':1,'classes':{},'objectVersion':56,'objects':objects,'rootObject':pid})+'\n')
schemes=project/'xcshareddata/xcschemes'; schemes.mkdir(parents=True,exist_ok=True)
ref=f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{tid}" BuildableName="{NAME}.app" BlueprintName="{NAME}" ReferencedContainer="container:{NAME}.xcodeproj"/>'
(schemes/(NAME+'.xcscheme')).write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2600" version="1.3"><BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{ref}</BuildActionEntry></BuildActionEntries></BuildAction><LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref}</BuildableProductRunnable></LaunchAction><ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref}</BuildableProductRunnable></ProfileAction><AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/></Scheme>
''')
info={'CFBundleDevelopmentRegion':'en','CFBundleDisplayName':'FFS Bridge','CFBundleExecutable':'$(EXECUTABLE_NAME)','CFBundleIdentifier':'$(PRODUCT_BUNDLE_IDENTIFIER)','CFBundleInfoDictionaryVersion':'6.0','CFBundleName':'$(PRODUCT_NAME)','CFBundlePackageType':'APPL','CFBundleShortVersionString':'$(MARKETING_VERSION)','CFBundleVersion':'$(CURRENT_PROJECT_VERSION)','LSRequiresIPhoneOS':True,'UIApplicationSupportsIndirectInputEvents':True,'UILaunchScreen':{},'UISupportedInterfaceOrientations':['UIInterfaceOrientationPortrait'],'NSBluetoothAlwaysUsageDescription':'Connect to your G2 glasses for apps, gestures, microphone audio and firmware updates.','NSLocalNetworkUsageDescription':'Allow this Mac to send builds and commands to your glasses through your iPhone.','NSBonjourServices':['_ffsbridge._tcp'],'UIBackgroundModes':['bluetooth-central'],'UIFileSharingEnabled':True,'LSSupportsOpeningDocumentsInPlace':True,'NSAppTransportSecurity':{'NSAllowsLocalNetworking':True},'ITSAppUsesNonExemptEncryption':False}
if MAC:
    for key in ['LSRequiresIPhoneOS','UIApplicationSupportsIndirectInputEvents','UILaunchScreen','UISupportedInterfaceOrientations','UIBackgroundModes','UIFileSharingEnabled','LSSupportsOpeningDocumentsInPlace','NSBonjourServices']:
        info.pop(key, None)
    info.update(CFBundleDisplayName='FFS Dev Bridge', NSPrincipalClass='NSApplication', NSBluetoothAlwaysUsageDescription='Connect directly to your G2 glasses for development, app uploads, microphone capture, and firmware updates.', NSBluetoothPeripheralUsageDescription='Connect directly to your G2 glasses for development.')
with (APP/('InfoMac.plist' if MAC else 'Info.plist')).open('wb') as f: plistlib.dump(info,f)
print(project)
