Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice("Microsoft Zira Desktop")
$s.Rate = -1
$s.Volume = 100
$s.SetOutputToWaveFile("D:\_AI_GENERATED\______2026\deepsea\assets\audio\voice\raw\v010.wav"); $s.Speak("Depth, ten meters.")
$s.SetOutputToWaveFile("D:\_AI_GENERATED\______2026\deepsea\assets\audio\voice\raw\v030.wav"); $s.Speak("Depth, thirty meters.")
$s.SetOutputToWaveFile("D:\_AI_GENERATED\______2026\deepsea\assets\audio\voice\raw\v060.wav"); $s.Speak("Depth, sixty meters.")
$s.SetOutputToWaveFile("D:\_AI_GENERATED\______2026\deepsea\assets\audio\voice\raw\v100.wav"); $s.Speak("Depth, one hundred meters.")
$s.SetOutputToWaveFile("D:\_AI_GENERATED\______2026\deepsea\assets\audio\voice\raw\v200.wav"); $s.Speak("Depth, two hundred meters.")
$s.SetOutputToWaveFile("D:\_AI_GENERATED\______2026\deepsea\assets\audio\voice\raw\v300.wav"); $s.Speak("Depth, three hundred meters.")
$s.SetOutputToWaveFile("D:\_AI_GENERATED\______2026\deepsea\assets\audio\voice\raw\v500.wav"); $s.Speak("Depth, five hundred meters.")
$s.SetOutputToWaveFile("D:\_AI_GENERATED\______2026\deepsea\assets\audio\voice\raw\v700.wav"); $s.Speak("Depth, seven hundred meters.")
$s.SetOutputToWaveFile("D:\_AI_GENERATED\______2026\deepsea\assets\audio\voice\raw\v1000.wav"); $s.Speak("Depth, one thousand meters.")
$s.SetOutputToWaveFile("D:\_AI_GENERATED\______2026\deepsea\assets\audio\voice\raw\v1500.wav"); $s.Speak("Depth, fifteen hundred meters.")
$s.SetOutputToWaveFile("D:\_AI_GENERATED\______2026\deepsea\assets\audio\voice\raw\v2000.wav"); $s.Speak("Depth, two thousand meters.")
$s.SetOutputToWaveFile("D:\_AI_GENERATED\______2026\deepsea\assets\audio\voice\raw\v3000.wav"); $s.Speak("Depth, three thousand meters.")
$s.SetOutputToWaveFile("D:\_AI_GENERATED\______2026\deepsea\assets\audio\voice\raw\v3800.wav"); $s.Speak("Depth, three thousand eight hundred meters.")
$s.SetOutputToWaveFile("D:\_AI_GENERATED\______2026\deepsea\assets\audio\voice\raw\v4000.wav"); $s.Speak("Depth, four thousand meters.")
$s.SetOutputToNull(); "done"