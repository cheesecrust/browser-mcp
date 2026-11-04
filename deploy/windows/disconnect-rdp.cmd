@echo off
rem Leave the RDP session without locking the desktop. Closing the RDP window locks the
rem session and Chrome stops painting (screenshots and the hand-over view go blank);
rem handing the session to the physical console keeps the desktop alive instead.
rem Run as Administrator from inside the RDP session.
for /f "tokens=3" %%s in ('query session ^| findstr /C:">"') do tscon %%s /dest:console
