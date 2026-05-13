/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  Hotel, 
  User, 
  CreditCard, 
  Clock, 
  CheckCircle2, 
  AlertCircle, 
  X, 
  Plus, 
  Smartphone,
  LogOut,
  ShieldAlert,
  Settings,
  Trash2,
  TrendingUp,
  LayoutDashboard,
  Calendar,
  Search,
  Info,
  Phone,
  FileText,
  Moon,
  Sun,
  Loader2,
  Wifi,
  Cpu
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  collection, 
  onSnapshot, 
  doc, 
  getDoc,
  getDocFromServer,
  addDoc, 
  updateDoc, 
  deleteDoc,
  setDoc,
  query,
  where,
  orderBy,
  limit
} from 'firebase/firestore';
import { 
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updatePassword,
  onAuthStateChanged,
  signOut,
  User as FirebaseUser
} from 'firebase/auth';
import { db, auth } from './firebase';

// --- Types ---

interface Room {
  id: string;
  number: string;
  type: string;
  pricePerHour: number;
  status: 'available' | 'occupied' | 'cleaning' | 'maintenance';
  currentBookingId?: string | null;
}

interface Guest {
  id: string;
  name: string;
  phone: string;
  documentNumber?: string;
  lastCardId?: string;
}

interface Booking {
  id: string;
  roomId: string;
  guestId: string;
  guestName: string; // Store name for permanent logs
  guestPhone: string; // Store phone for permanent logs
  checkInTime: string;
  checkOutTime?: string;
  cardId: string;
  status: 'active' | 'completed';
  totalHours?: number;
  totalAmount?: number;
  reservationDeposit?: number; // Track if paid via reservation
}

interface Reservation {
  id: string;
  roomId: string;
  guestName: string;
  guestPhone: string;
  arrivalTime: string;
  depositPaid: number;
  status: 'pending' | 'confirmed' | 'checked-in' | 'expired' | 'cancelled';
  createdAt: string;
}

interface Staff {
  id: string;
  name: string;
  email: string;
  role: 'receptionist' | 'manager';
}

// --- Integration Error Handling ---

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
    },
    operationType,
    path
  };
  console.error('Firestore Error Details: ', JSON.stringify(errInfo));
  // We alert the user with a clearer message if it's a permission issue
  if (errInfo.error.includes('permissions')) {
    alert(`Erro de Permissão (Firestore): Você não tem autorização para realizar esta operação (${operationType} em ${path}). Verifique se seu e-mail está cadastrado na equipe.`);
  }
}

// --- Utils ---

const ADMIN_EMAIL = 'ivopacavira6@gmail.com';

const calculateBilling = (checkInStr: string, pricePerHour: number) => {
  const checkIn = new Date(checkInStr);
  const now = new Date();
  const diffMs = now.getTime() - checkIn.getTime();
  const diffHours = Math.ceil(diffMs / (1000 * 60 * 60));
  const totalHours = Math.max(1, diffHours); // Minimum 1 hour
  
  const h = Math.floor(diffMs / (1000 * 60 * 60));
  const m = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  return {
    totalHours,
    totalAmount: totalHours * pricePerHour,
    durationStr: `${h}h ${m}m`
  };
};

const generateMockCardId = () => {
  return 'RFID-' + Math.random().toString(36).substring(2, 9).toUpperCase();
};

// --- Components ---

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [guests, setGuests] = useState<Guest[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'receptionist' | 'guest' | 'admin'>('receptionist');
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null);
  const [isRegistering, setIsRegistering] = useState(false);
  const [isCheckingOut, setIsCheckingOut] = useState(false);
  const [activeBooking, setActiveBooking] = useState<Booking | null>(null);
  const [now, setNow] = useState(new Date());
  const [isOffline, setIsOffline] = useState(false);
  const [isAuthOffline, setIsAuthOffline] = useState(false);

  useEffect(() => {
    async function testConnection() {
      // Test Firestore
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
        setIsOffline(false);
      } catch (error) {
        if (error instanceof Error && (error.message.includes('the client is offline') || error.message.includes('unavailable'))) {
          setIsOffline(true);
        }
      }

      // Test Auth Domain Reachability (indirectly)
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup', { 
          method: 'POST', 
          signal: controller.signal,
          mode: 'no-cors' // We just want to see if we can reach it
        });
        clearTimeout(timeoutId);
        setIsAuthOffline(false);
      } catch (error) {
        console.warn("Auth endpoint check failed:", error);
        setIsAuthOffline(true);
      }
    }
    testConnection();
    
    // Check periodically
    const interval = setInterval(testConnection, 30000);
    return () => clearInterval(interval);
  }, []);

  // Timer to update "now" every minute
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(interval);
  }, []);
  
  // Form State
  const [guestForm, setGuestForm] = useState({
    name: '',
    phone: '',
    documentNumber: ''
  });
  const [isSwiping, setIsSwiping] = useState(false);
  const [tempSwipedCard, setTempSwipedCard] = useState<string | null>(null);
  const [lastScannedId, setLastScannedId] = useState<string | null>(null);
  
  // --- Hardware Integration (RFID/MFRC522) ---
  const [serialPort, setSerialPort] = useState<any>(null);
  const [isHardwareConnected, setIsHardwareConnected] = useState(false);
  const [scanBuffer, setScanBuffer] = useState('');
  const [lastCharTime, setLastCharTime] = useState(0);

  // Refs to avoid stale closures in the loop
  const isRegisteringRef = useRef(isRegistering);
  const bookingsRef = useRef(bookings);
  const roomsRef = useRef(rooms);

  useEffect(() => {
    isRegisteringRef.current = isRegistering;
    bookingsRef.current = bookings;
    roomsRef.current = rooms;
  }, [isRegistering, bookings, rooms]);

  // Fallback: Global keyboard listener for readers acting as keyboards (HID)
  useEffect(() => {
    const handleGlobalKeydown = (e: KeyboardEvent) => {
      // Ignore if user is inside a real input (to avoid interference)
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;

      const now = Date.now();
      const diff = now - lastCharTime;

      if (e.key === 'Enter') {
        if (scanBuffer.length >= 4) {
          processRFIDScan(scanBuffer);
          setScanBuffer('');
        }
        return;
      }

      // If typing is fast (< 50ms), it's likely a scanner
      if (e.key.length === 1) {
        if (diff < 50 || scanBuffer === '') {
          setScanBuffer(prev => prev + e.key);
        } else {
          setScanBuffer(e.key);
        }
      }
      setLastCharTime(now);
    };

    window.addEventListener('keydown', handleGlobalKeydown);
    return () => window.removeEventListener('keydown', handleGlobalKeydown);
  }, [scanBuffer, lastCharTime]);

  const connectHardware = async () => {
    try {
      if (!('serial' in navigator)) {
        alert("Seu navegador não suporta a Web Serial API. Use o Chrome ou Edge.");
        return;
      }
      
      const port = await (navigator as any).serial.requestPort();
      await port.open({ baudRate: 9600 });
      setSerialPort(port);
      setIsHardwareConnected(true);
      
      const textDecoder = new TextDecoderStream();
      port.readable.pipeTo(textDecoder.writable);
      const reader = textDecoder.readable.getReader();

      let dataBuffer = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            dataBuffer += value;
            const lines = dataBuffer.split('\n');
            // Keep the incomplete last line in the buffer
            dataBuffer = lines.pop() || '';
            
            for (const line of lines) {
              const cleanId = line.trim();
              if (cleanId.length >= 4) {
                processRFIDScan(cleanId);
              }
            }
          }
        }
      } catch (error) {
        console.error("Erro na leitura serial:", error);
      } finally {
        reader.releaseLock();
      }
    } catch (err: any) {
      if (err.name === 'NotFoundError') {
        console.log("Seleção de porta cancelada pelo usuário.");
        return;
      }
      console.error("Falha ao conectar hardware:", err);
      if (err.message.includes('Permissions policy')) {
        alert("⚠️ ATENÇÃO: O acesso ao hardware é bloqueado dentro do editor (iframe).\n\nPara conectar seu leitor RFID real:\n1. Clique no ícone 'Abrir em nova aba' (canto superior direito do preview).\n2. No app aberto na nova aba, o botão funcionará normalmente!");
      } else {
        alert("Falha ao conectar sensor. Verifique se o cabo USB está firme.");
      }
    }
  };

  const processRFIDScan = (cardId: string) => {
    const cleanId = cardId.trim().toUpperCase();
    if (!cleanId) return;
    
    console.log("RFID Detectado:", cleanId);
    setLastScannedId(cleanId);
    
    // Feedback visual
    setIsSwiping(true);
    
    // Use refs to avoid stale values in background loops
    const registering = isRegisteringRef.current;
    const currentBookings = bookingsRef.current;
    const currentRooms = roomsRef.current;

    // Logic for check-in/check-out
    if (registering) {
      // If modal is open, assign card to the current form
      setTempSwipedCard(cleanId);
    } else {
      // If modal is closed, try to find an active guest to trigger checkout automatically
      const activeBookingFound = currentBookings.find(b => b.cardId === cleanId && b.status === 'active');
      if (activeBookingFound) {
        const room = currentRooms.find(r => r.id === activeBookingFound.roomId);
        if (room) {
          setSelectedRoom(room);
          setActiveBooking(activeBookingFound);
          setIsCheckingOut(true);
        }
      } else {
        // Just save it as potential card
        setTempSwipedCard(cleanId);
      }
    }

    setTimeout(() => {
      setIsSwiping(false);
    }, 800);
  };

  // Initialize Auth
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsLoading(false);
    });
    return unsubscribe;
  }, []);

  // Auto-expire reservations
  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date().getTime();
      reservations.forEach(async (res) => {
        if (res.status === 'confirmed' && new Date(res.arrivalTime).getTime() < now) {
          try {
            await updateDoc(doc(db, 'reservations', res.id), { status: 'expired' });
          } catch (err) {
            handleFirestoreError(err, OperationType.UPDATE, `reservations/${res.id}`);
          }
        }
      });
    }, 60000); // Check every minute
    return () => clearInterval(timer);
  }, [reservations]);

  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [emailForm, setEmailForm] = useState({ email: '', password: '' });
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [newPassword, setNewPassword] = useState('');

  const [mustChangePassword, setMustChangePassword] = useState(false);

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoggingIn) return;
    setIsLoggingIn(true);
    
    const email = emailForm.email.trim().toLowerCase();
    const password = emailForm.password.trim();

    try {
      // Try to sign in first
      try {
        await signInWithEmailAndPassword(auth, email, password);
        if (password === '123456') {
          setMustChangePassword(true);
        }
      } catch (signInErr: any) {
        console.warn("Sign-in attempt failed:", signInErr.code, signInErr.message);
        
        // auth/invalid-credential is the new generic error for both user-not-found and wrong-password
        const isFirstLoginCandidate = 
          signInErr.code === 'auth/user-not-found' || 
          signInErr.code === 'auth/invalid-credential' || 
          signInErr.message?.includes('invalid-credential') ||
          signInErr.message?.includes('user-not-found');
        
        if (isFirstLoginCandidate && password === '123456') {
          let staffDoc;
          try {
            staffDoc = await getDoc(doc(db, 'staff', email));
          } catch (docErr) {
            handleFirestoreError(docErr, OperationType.GET, `staff/${email}`);
            throw docErr;
          }
          
          if (staffDoc.exists() || email === ADMIN_EMAIL) {
            try {
              console.log("Attempting first-time registration for authorized user:", email);
              await createUserWithEmailAndPassword(auth, email, password);
              setMustChangePassword(true);
              return;
            } catch (createErr: any) {
              // If user already exists, then the sign-in error was actually due to wrong password
              if (createErr.code === 'auth/email-already-in-use') {
                throw new Error("Senha incorreta. Se você já alterou sua senha padrão de '123456', por favor use a nova senha.");
              }
              throw createErr;
            }
          }
        }
        
        // Rethrow if not a candidate for auto-registration OR auth found but password wrong
        throw signInErr;
      }
    } catch (err: any) {
      console.error("Login catch-all:", err);
      const msg = err.message || "";
      const code = err.code || "";

      if (code === 'auth/wrong-password' || code === 'auth/invalid-credential' || msg.includes('invalid-credential') || msg.includes('wrong-password')) {
        alert("Acesso negado: E-mail ou senha incorretos. \n\n⚠️ Se este é seu primeiro acesso, use a senha padrão: 123456\n\nCaso já tenha alterado sua senha, use a senha definida por você.");
      } else if (code === 'auth/user-not-found' || msg.includes('user-not-found')) {
        alert("E-mail não autorizado ou não cadastrado no painel administrativo.");
      } else if (code === 'auth/operation-not-allowed' || msg.includes("operation-not-allowed")) {
        alert("Configuração Pendente: O login por e-mail/senha não está ativo no Firebase Console.");
      } else if (code === 'auth/network-request-failed' || msg.includes('network-request-failed')) {
        setIsAuthOffline(true);
        alert("⚠️ ERRO DE REDE: Seu navegador não conseguiu falar com o servidor de login do Google (Firebase).\n\nCausas prováveis:\n1. Um Bloqueador de Anúncios (AdBlock) está ativado.\n2. Sua rede local bloqueia domínios 'googleapis.com'.\n3. Erro de permissão no Iframe (Tente o botão 'Abrir em nova aba' no canto superior direito do Preview).");
      } else if (code === 'auth/invalid-email' || msg.includes('invalid-email')) {
        alert("E-mail inválido. Por favor, verifique o que digitou.");
      } else {
        alert("Erro no acesso: " + (err.message || "Tente novamente mais tarde."));
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleChangePassword = async () => {
    if (!user || !newPassword) return;
    try {
      await updatePassword(user, newPassword);
      alert("Senha alterada com sucesso!");
      setShowPasswordModal(false);
      setNewPassword('');
    } catch (err: any) {
      console.error(err);
      alert("Erro ao alterar senha. Talvez você precise sair e entrar novamente por segurança.");
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch (err) {
      console.error("Logout error:", err);
    }
  };

  // --- Derived State & Logic ---
  const isAdmin = user?.email === ADMIN_EMAIL;
  const isAuthorizedStaff = staff.some(s => s.email === user?.email) || isAdmin;

  // Sync viewMode based on auth
  useEffect(() => {
    if (!user) {
      setViewMode('guest');
    } else if (isAdmin) {
      setViewMode('admin');
    } else if (isAuthorizedStaff) {
      setViewMode('receptionist');
    } else {
      setViewMode('guest');
    }
  }, [user, isAdmin, isAuthorizedStaff]);

  // Fetch Data
  useEffect(() => {
    // Rooms and Reservations are public for online scheduling
    const unsubRooms = onSnapshot(collection(db, 'rooms'), (snapshot) => {
      const roomsData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Room));
      roomsData.sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
      setRooms(roomsData);

      if (roomsData.length === 0 && isAdmin) { // Seed only if admin is logged in
        seedRooms();
      }
      setIsLoading(false);
    }, (error) => handleFirestoreError(error, OperationType.LIST, 'rooms'));

    const unsubReservations = onSnapshot(collection(db, 'reservations'), (snapshot) => {
      setReservations(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Reservation)));
    }, (error) => handleFirestoreError(error, OperationType.LIST, 'reservations'));

    // Guests, Bookings and Staff are private
    let unsubGuests = () => {};
    let unsubBookings = () => {};
    let unsubStaff = () => {};

    if (user && isAuthorizedStaff) {
      unsubGuests = onSnapshot(collection(db, 'guests'), (snapshot) => {
        setGuests(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Guest)));
      }, (error) => handleFirestoreError(error, OperationType.LIST, 'guests'));

      unsubBookings = onSnapshot(collection(db, 'bookings'), (snapshot) => {
        setBookings(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Booking)));
      }, (error) => handleFirestoreError(error, OperationType.LIST, 'bookings'));

      unsubStaff = onSnapshot(collection(db, 'staff'), (snapshot) => {
        setStaff(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Staff)));
      }, (error) => handleFirestoreError(error, OperationType.LIST, 'staff'));
    } else if (user) {
      unsubStaff = onSnapshot(collection(db, 'staff'), (snapshot) => {
        setStaff(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Staff)));
      }, (error) => handleFirestoreError(error, OperationType.LIST, 'staff'));
    }

    return () => {
      unsubRooms();
      unsubReservations();
      unsubStaff();
      unsubGuests();
      unsubBookings();
    };
  }, [user]);

  // Check for expired reservations every minute
  useEffect(() => {
    const checkExpirations = async () => {
      if (!user) return;
      const now = new Date();
      const stales = reservations.filter(r => r.status === 'confirmed' && new Date(r.arrivalTime) < now);
      
      for (const res of stales) {
        try {
          await updateDoc(doc(db, 'reservations', res.id), { status: 'expired' });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `reservations/${res.id}`);
        }
      }
    };
    const interval = setInterval(checkExpirations, 60000);
    return () => clearInterval(interval);
  }, [user, reservations]);

  const seedRooms = async () => {
    const path = 'rooms';
    try {
      const initialRooms = [
        { number: '101', type: 'Single Standard', pricePerHour: 20, status: 'available' },
        { number: '102', type: 'Single Standard', pricePerHour: 20, status: 'available' },
        { number: '103', type: 'Double Standard', pricePerHour: 35, status: 'available' },
        { number: '104', type: 'Double Standard', pricePerHour: 35, status: 'available' },
        { number: '201', type: 'Suite Deluxe', pricePerHour: 60, status: 'available' },
        { number: '202', type: 'Suite Deluxe', pricePerHour: 60, status: 'available' },
        { number: '203', type: 'Presidential', pricePerHour: 120, status: 'available' },
      ];

      for (const room of initialRooms) {
        await addDoc(collection(db, path), room);
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, path);
    }
  };

  // --- Handlers ---

  const handleRoomClick = (room: Room) => {
    setSelectedRoom(room);
    if (room.status === 'occupied') {
      const booking = bookings.find(b => b.id === room.currentBookingId && b.status === 'active');
      if (booking) {
        setActiveBooking(booking);
        setIsCheckingOut(true);
      }
    } else if (room.status === 'available') {
      setIsRegistering(true);
    }
  };

  const closeModal = () => {
    setSelectedRoom(null);
    setIsRegistering(false);
    setIsCheckingOut(false);
    setActiveBooking(null);
    setGuestForm({ name: '', phone: '', documentNumber: '' });
    setTempSwipedCard(null);
    setIsSwiping(false);
  };

  const simulateSwipe = () => {
    setIsSwiping(true);
    setTimeout(() => {
      const cardId = generateMockCardId();
      setTempSwipedCard(cardId);
      setIsSwiping(false);
    }, 1200);
  };

  const handleCheckIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRoom || !tempSwipedCard) return;

    try {
      const guestRef = await addDoc(collection(db, 'guests'), {
        ...guestForm,
        lastCardId: tempSwipedCard
      });

      const currentReservation = reservations.find(r => r.roomId === selectedRoom.id && r.status === 'confirmed');

      const bookingRef = await addDoc(collection(db, 'bookings'), {
        roomId: selectedRoom.id,
        guestId: guestRef.id,
        guestName: guestForm.name,
        guestPhone: guestForm.phone,
        checkInTime: new Date().toISOString(),
        cardId: tempSwipedCard,
        status: 'active',
        reservationDeposit: currentReservation?.depositPaid || 0
      });

      await updateDoc(doc(db, 'rooms', selectedRoom.id), {
        status: 'occupied',
        currentBookingId: bookingRef.id
      });

      if (currentReservation) {
        await updateDoc(doc(db, 'reservations', currentReservation.id), {
          status: 'checked-in'
        });
      }

      closeModal();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'check-in batch');
    }
  };

  const handleCheckOut = async () => {
    if (!selectedRoom || !activeBooking) return;

    const billing = calculateBilling(activeBooking.checkInTime, selectedRoom.pricePerHour);

    try {
      await updateDoc(doc(db, 'bookings', activeBooking.id), {
        status: 'completed',
        checkOutTime: new Date().toISOString(),
        totalHours: billing.totalHours,
        totalAmount: billing.totalAmount
      });

      await updateDoc(doc(db, 'rooms', selectedRoom.id), {
        status: 'cleaning',
        currentBookingId: null
      });

      // Simulation: Room stays cleaning for some time then becomes available
      setTimeout(async () => {
        try {
          await updateDoc(doc(db, 'rooms', selectedRoom.id), {
            status: 'available'
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `rooms/${selectedRoom.id}`);
        }
      }, 8000);

      closeModal();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'check-out batch');
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center transition-colors">
        <motion.div 
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
          className="w-12 h-12 border-4 border-indigo-600 border-t-transparent rounded-full"
        />
      </div>
    );
  }

  if (!user && viewMode !== 'guest') {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center p-6 transition-colors font-sans">
        <AnimatePresence>
          {(isOffline || isAuthOffline) && (
            <motion.div 
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="fixed top-0 left-0 right-0 bg-red-600 text-white text-center py-2 text-[10px] font-black uppercase tracking-[0.2em] z-[100]"
            >
              {isAuthOffline ? '⚠️ BLOQUEIO DE REDE: Login do Google Inacessível. Use o botão "Abrir em nova aba" do preview.' : 'Erro de Conexão: O banco de dados está inacessível.'}
            </motion.div>
          )}
        </AnimatePresence>
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full bg-slate-900 rounded-[3rem] p-12 shadow-2xl shadow-black/50 border border-white/10 text-center"
        >
          <div className="bg-indigo-600 w-20 h-20 rounded-[2rem] flex items-center justify-center mx-auto mb-8 shadow-xl shadow-indigo-500/20">
            <Hotel className="text-white w-10 h-10" />
          </div>
          <h1 className="text-3xl font-black text-white tracking-tight mb-2">Hotel Master</h1>
          <p className="text-white/40 font-bold uppercase tracking-widest text-[10px] mb-12">Portal de Gestão & Reservas</p>
           <div className="space-y-4">
            <form onSubmit={handleEmailLogin} className="space-y-4 text-left">
              <div className="space-y-1">
                <label className="text-[10px] font-black uppercase tracking-widest text-white/40 ml-4 mb-2 block">E-mail</label>
                <input 
                  type="email" 
                  placeholder="Seu E-mail" 
                  required
                  value={emailForm.email}
                  onChange={e => setEmailForm({...emailForm, email: e.target.value})}
                  className="w-full px-6 py-4 bg-white/5 border-2 border-transparent focus:border-indigo-600 rounded-2xl outline-none transition-all font-bold text-white placeholder:text-white/10"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-black uppercase tracking-widest text-white/40 ml-4 mb-2 block">Senha</label>
                <input 
                  type="password" 
                  placeholder="Senha Administrativa" 
                  required
                  value={emailForm.password}
                  onChange={e => setEmailForm({...emailForm, password: e.target.value})}
                  className="w-full px-6 py-4 bg-white/5 border-2 border-transparent focus:border-indigo-600 rounded-2xl outline-none transition-all font-bold text-white placeholder:text-white/10"
                />
              </div>
              <button 
                type="submit"
                disabled={isLoggingIn}
                className="w-full bg-indigo-600 text-white py-5 rounded-[2rem] font-black uppercase tracking-widest shadow-xl hover:bg-indigo-700 transition-all active:scale-95 mt-4"
              >
                {isLoggingIn ? 'Autenticando...' : 'Entrar no Sistema'}
              </button>
              
              <div className="pt-4 border-t border-white/10">
                <p className="text-center text-xs text-white/40 font-bold leading-relaxed">
                  <span className="text-indigo-400 font-black">Primeiro acesso?</span><br />
                  Use seu e-mail autorizado e a senha padrão <span className="bg-indigo-500/10 px-1.5 py-0.5 rounded text-indigo-400 font-black">123456</span> para ativar sua conta.
                </p>
              </div>
            </form>

            <div className="py-4 flex items-center gap-4 text-white/5">
              <div className="flex-1 h-px bg-white/10" />
              <span className="text-[10px] font-black uppercase text-white/20">Ou</span>
              <div className="flex-1 h-px bg-white/10" />
            </div>

            <button 
              onClick={() => setViewMode('guest')}
              className="w-full flex items-center justify-center gap-4 bg-white/5 text-indigo-400 border-2 border-indigo-500/20 py-5 rounded-[2rem] font-black uppercase tracking-widest shadow-lg shadow-indigo-500/5 hover:bg-indigo-500/10 transition-all active:scale-95"
            >
              <Calendar className="w-5 h-5" />
              Reserva Online
            </button>
          </div>
          
          <p className="mt-8 text-[11px] text-white/20 font-medium">
            Portal administrativo restrito à equipe autorizada. Clientes podem usar o agendamento online.
          </p>
        </motion.div>
      </div>
    );
  }

  if (user && !isAuthorizedStaff && viewMode !== 'guest') {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center p-6 text-center">
        <div className="max-w-md space-y-6">
          <div className="bg-red-500/10 p-6 rounded-full w-24 h-24 flex items-center justify-center mx-auto text-red-500 shadow-xl shadow-red-500/10 border border-red-500/20">
            <ShieldAlert className="w-12 h-12" />
          </div>
          <h2 className="text-3xl font-black text-white">Acesso Negado</h2>
          <p className="text-white/40 font-medium leading-relaxed">Você está autenticado como <b className="text-white">{user.email}</b>, mas este e-mail não possui permissão para acessar o painel administrativo.</p>
          <button onClick={handleLogout} className="bg-indigo-600 text-white px-8 py-4 rounded-2xl font-black uppercase tracking-widest hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-500/20">Trocar Conta</button>
          <button onClick={() => setViewMode('guest')} className="block mx-auto text-indigo-400 font-bold underline underline-offset-4">Ir para Reservas Online</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white font-sans selection:bg-indigo-500 selection:text-white transition-colors">
      <AnimatePresence>
        {isOffline && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="bg-red-600 text-white text-center py-2 text-[10px] font-black uppercase tracking-[0.2em] relative z-[100]"
          >
            Erro de Conexão: O banco de dados está inacessível. O sistema funcionará apenas em modo leitura (Cache).
          </motion.div>
        )}
      </AnimatePresence>
      {/* Header for Guest or Admin */}
      <header className="bg-black/60 border-b border-white/5 px-6 py-4 flex items-center justify-between sticky top-0 z-40 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="bg-indigo-600 p-2.5 rounded-2xl shadow-lg shadow-indigo-500/20">
            <Hotel className="text-white w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-black tracking-tight text-white">Hotel Master</h1>
            <p className="text-[10px] text-white/40 font-bold uppercase tracking-[0.2em] -mt-1 underline decoration-indigo-500 decoration-2 underline-offset-4">
              {viewMode === 'guest' ? 'Portal do Hóspede' : 'Sistema de Recepção'}
            </p>
          </div>
        </div>
        
        <div className="flex items-center gap-6">
          {/* Hardware Connection Action */}
          <div className="flex flex-col items-end gap-1">
            <button 
              onClick={connectHardware}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest border transition-all
                ${isHardwareConnected 
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' 
                  : 'bg-indigo-600 text-white border-indigo-600 shadow-lg shadow-indigo-500/20 hover:bg-indigo-700 active:scale-95'}`}
            >
              {isHardwareConnected ? <Wifi className="w-4 h-4" /> : <Cpu className="w-4 h-4" />}
              {isHardwareConnected ? 'Sensor USB Local Online' : 'Clique para Ligar Sensor USB'}
            </button>
            {!isHardwareConnected && (
              <div className="flex flex-col items-end">
                <span className="text-[8px] text-indigo-400 font-bold uppercase tracking-tighter mr-2 animate-pulse">
                  ⚠ Use o ícone "Abrir em nova aba" acima para habilitar USB
                </span>
                <span className="text-[7px] text-white/10 font-bold uppercase tracking-widest mr-2">
                  Ou apenas escaneie (Modo Teclado Ativo)
                </span>
              </div>
            )}
            {isHardwareConnected && lastScannedId && (
              <div className="flex items-center gap-2 bg-emerald-500/5 px-3 py-1 rounded-lg border border-emerald-500/10">
                <span className="text-[7px] font-black text-emerald-400/50 uppercase tracking-widest">Último ID:</span>
                <span className="text-[9px] font-mono font-bold text-emerald-400 tracking-wider">{lastScannedId}</span>
              </div>
            )}
          </div>

          {user && (
            <>
              <button 
                onClick={() => setViewMode(viewMode === 'receptionist' ? 'guest' : 'receptionist')}
                className="flex items-center gap-2 px-4 py-2 bg-white/5 text-white rounded-xl font-black text-[10px] uppercase tracking-widest border border-white/10 hover:bg-white/10 transition-all font-sans"
              >
                {viewMode === 'guest' ? <LayoutDashboard className="w-4 h-4" /> : <Calendar className="w-4 h-4" />}
                {viewMode === 'guest' ? 'Painel de Gestão' : 'Reservas Online'}
              </button>

              {isAdmin && (
                <button 
                  onClick={() => setViewMode(viewMode === 'admin' ? 'receptionist' : 'admin')}
                  className={`flex items-center gap-2 px-4 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest border transition-all
                    ${viewMode === 'admin' 
                      ? 'bg-indigo-600 text-white border-indigo-600 shadow-lg shadow-indigo-500/20' 
                      : 'bg-white/5 text-white/60 border-white/10 hover:bg-white/10'}`}
                >
                  <ShieldAlert className="w-4 h-4" />
                  Adm Master
                </button>
              )}
            </>
          )}

          {!user && viewMode === 'guest' && (
             <button 
                onClick={() => setViewMode('receptionist')}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-500/20"
              >
                <LogOut className="w-4 h-4 rotate-180" />
                Login Equipe
              </button>
          )}

          <div className="hidden sm:flex flex-col items-end">
            <div className="flex items-center gap-2">
              <p className="text-sm font-bold text-white/80">{new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
              {user && (
                <button 
                  onClick={() => setShowPasswordModal(true)}
                  className="p-1.5 text-white/20 hover:text-indigo-400 transition-colors"
                  title="Alterar Minha Senha"
                >
                  <Settings className="w-4 h-4" />
                </button>
              )}
            </div>
            {user && <p className="text-[11px] text-white/30 font-medium">{user.email}</p>}
          </div>

          <AnimatePresence>
            {showPasswordModal && (
              <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-6">
                <motion.div 
                  initial={{ scale: 0.9, opacity: 0 }} 
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.9, opacity: 0 }}
                  className="bg-slate-900 rounded-[2.5rem] p-10 max-w-sm w-full shadow-2xl relative border border-white/10"
                >
                  <button onClick={() => setShowPasswordModal(false)} className="absolute top-6 right-6 text-white/20 hover:text-white/50">
                    <X className="w-6 h-6" />
                  </button>
                  <div className="bg-indigo-500/10 w-16 h-16 rounded-2xl flex items-center justify-center text-indigo-400 mb-6">
                    <ShieldAlert className="w-8 h-8" />
                  </div>
                  <h3 className="text-2xl font-black text-white mb-2">Alterar Senha</h3>
                  <p className="text-sm text-white/40 font-medium mb-8">Defina uma nova senha para sua conta de acesso.</p>
                  
                  <input 
                    type="password" 
                    placeholder="Nova Senha"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    className="w-full px-6 py-4 bg-white/5 border-2 border-transparent focus:border-indigo-600 rounded-2xl mb-8 outline-none font-bold transition-all text-white"
                  />
                  
                  <div className="flex gap-4">
                    <button 
                      onClick={() => setShowPasswordModal(false)} 
                      className="flex-1 py-4 font-black uppercase text-[10px] tracking-widest bg-white/5 text-white/40 rounded-xl hover:bg-white/10 transition-all font-sans"
                    >
                      Cancelar
                    </button>
                    <button 
                      onClick={handleChangePassword} 
                      className="flex-1 py-4 font-black uppercase text-[10px] tracking-widest bg-indigo-600 text-white rounded-xl shadow-lg shadow-indigo-500/20 transition-all font-sans"
                    >
                      Atualizar
                    </button>
                  </div>
                </motion.div>
              </div>
            )}
          </AnimatePresence>

          {user && (
            <button 
              onClick={handleLogout}
              className="h-10 w-10 bg-white/5 rounded-full flex items-center justify-center border border-white/10 cursor-pointer hover:bg-red-500/10 hover:border-red-500/50 hover:text-red-500 transition-all group"
            >
              <LogOut className="w-5 h-5 text-white/30 group-hover:text-red-500" />
            </button>
          )}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {viewMode === 'guest' ? (
          <GuestReservationView 
            rooms={rooms} 
            reservations={reservations} 
            onSuccess={() => setViewMode('receptionist')} 
          />
        ) : viewMode === 'admin' ? (
          isAdmin && (
            <AdminMasterPanel 
              rooms={rooms} 
              bookings={bookings} 
              guests={guests} 
              reservations={reservations} 
              staff={staff}
              onCheckIn={(res) => {
                const room = rooms.find(r => r.id === res.roomId);
                if (room) {
                  setSelectedRoom(room);
                  setGuestForm({ name: res.guestName, phone: res.guestPhone, documentNumber: '' });
                  setIsRegistering(true);
                  setViewMode('receptionist');
                }
              }}
            />
          )
        ) : (
          isAuthorizedStaff && (
            <>
              {/* Stats Section */}
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-6 mb-12">
                {[
                  { label: 'Disponíveis', value: rooms.filter(r => r.status === 'available').length, icon: CheckCircle2, color: 'emerald', sub: 'Prontos para check-in' },
                  { label: 'Ocupados', value: rooms.filter(r => r.status === 'occupied').length, icon: AlertCircle, color: 'indigo', sub: 'Estadias em andamento' },
                  { label: 'Reservados', value: reservations.filter(r => r.status === 'confirmed').length, icon: Calendar, color: 'amber', sub: 'Aguardando chegada' },
                  { label: 'Limpeza', value: rooms.filter(r => r.status === 'cleaning').length, icon: Clock, color: 'slate', sub: 'Aguardando manutenção' }
                ].map((stat) => (
                  <div key={stat.label} className="bg-slate-900/40 p-6 rounded-[2rem] border border-white/5 shadow-sm relative overflow-hidden group">
                    <div className={`absolute top-0 right-0 w-32 h-32 -mr-8 -mt-8 rounded-full opacity-5 group-hover:scale-110 transition-transform duration-500
                      ${stat.color === 'emerald' ? 'bg-emerald-600' : stat.color === 'indigo' ? 'bg-indigo-600' : stat.color === 'amber' ? 'bg-amber-600' : 'bg-slate-600'}`} 
                    />
                    <div className="flex items-center justify-between mb-4 relative z-10">
                      <div className={`p-3 rounded-2xl
                        ${stat.color === 'emerald' ? 'bg-emerald-500/10 text-emerald-400' : 
                          stat.color === 'indigo' ? 'bg-indigo-500/10 text-indigo-400' : 
                          stat.color === 'amber' ? 'bg-amber-500/10 text-amber-400' : 
                          'bg-slate-500/10 text-slate-400'}`}>
                        <stat.icon className="w-6 h-6" />
                      </div>
                      <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-lg
                        ${stat.color === 'emerald' ? 'bg-emerald-500/20 text-emerald-400' : 
                          stat.color === 'indigo' ? 'bg-indigo-500/20 text-indigo-400' : 
                          stat.color === 'amber' ? 'bg-amber-500/20 text-amber-400' : 
                          'bg-white/5 text-white/40'}`}>
                        {stat.label}
                      </span>
                    </div>
                    <h3 className="text-4xl font-black text-white tracking-tighter relative z-10">{stat.value}</h3>
                    <p className="text-xs text-white/30 font-bold mt-1 uppercase tracking-wider relative z-10">{stat.sub}</p>
                  </div>
                ))}
              </div>

              {/* Dashboard Title & Actions */}
              <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-8">
                <div>
                  <h2 className="text-3xl font-black text-white tracking-tight">Ocupação em Tempo Real</h2>
                  <p className="text-white/40 font-medium">Selecione um quarto para realizar check-in ou check-out</p>
                </div>
                {mustChangePassword && (
                  <motion.div 
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="bg-amber-500/10 border border-amber-500/20 p-4 rounded-2xl flex items-center gap-4 shadow-sm"
                  >
                    <ShieldAlert className="w-5 h-5 text-amber-500" />
                    <p className="text-[10px] font-black text-amber-200 uppercase tracking-tight">
                      Atenção: Você está usando a senha padrão.
                    </p>
                    <button 
                      onClick={() => setShowPasswordModal(true)}
                      className="bg-amber-600 text-white px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest hover:bg-amber-700 transition-colors"
                    >
                      Mudar Agora
                    </button>
                    <button onClick={() => setMustChangePassword(false)} className="text-amber-500/40 hover:text-amber-500">
                      <X className="w-4 h-4" />
                    </button>
                  </motion.div>
                )}
                <div className="flex items-center gap-3 bg-white/5 p-2 rounded-2xl border border-white/10 shadow-sm self-start md:self-auto">
                    <div className="flex items-center px-3 py-2 bg-white/5 rounded-xl text-white/30">
                      <Search className="w-4 h-4 mr-2" />
                      <input type="text" placeholder="Localizar quarto..." className="bg-transparent outline-none text-sm font-medium text-white/60 w-32 focus:w-48 transition-all" />
                    </div>
                  </div>
                </div>

                {/* Room Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6 mb-16">
                  <AnimatePresence mode="popLayout">
                    {rooms.map((room) => {
                      const hasReservation = reservations.some(r => r.roomId === room.id && r.status === 'confirmed');
                      return (
                        <motion.button
                          key={room.id}
                          layout
                          initial={{ opacity: 0, scale: 0.9 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.9 }}
                          whileHover={{ y: -8, scale: 1.02 }}
                          whileTap={{ scale: 0.98 }}
                          onClick={() => handleRoomClick(room)}
                          className={`
                            relative aspect-[4/5] p-5 rounded-[2.5rem] border-2 transition-all flex flex-col justify-between text-left group
                            ${room.status === 'available' ? (hasReservation ? 'bg-amber-500/10 border-amber-500/20 shadow-sm' : 'bg-white/5 border-white/5 hover:border-indigo-500 hover:shadow-2xl hover:shadow-indigo-500/20') : ''}
                            ${room.status === 'occupied' ? 'bg-indigo-600 border-indigo-600 text-white shadow-xl shadow-indigo-500/20' : ''}
                            ${room.status === 'cleaning' ? 'bg-slate-800 border-slate-800 text-white/40' : ''}
                            ${room.status === 'maintenance' ? 'bg-red-500/10 border-red-500/20 text-red-400' : ''}
                          `}
                        >
                          <div className="flex justify-between items-start">
                            <div className={`p-3 rounded-2xl backdrop-blur-sm transition-transform group-hover:rotate-12
                              ${room.status === 'available' ? (hasReservation ? 'bg-amber-500/20 text-amber-400' : 'bg-white/10 text-white/20') : room.status === 'maintenance' ? 'bg-red-500/20 text-red-400' : 'bg-white/20 text-white'}`}>
                              <span className="text-xl font-black">{room.number}</span>
                            </div>
                            {room.status === 'occupied' && <Smartphone className="w-5 h-5 text-indigo-200 animate-pulse" />}
                            {room.status === 'cleaning' && <Clock className="w-5 h-5 text-white/20" />}
                            {room.status === 'available' && hasReservation && <Calendar className="w-5 h-5 text-amber-400" />}
                            {room.status === 'maintenance' && <ShieldAlert className="w-5 h-5 text-red-500" />}
                          </div>
                      
                      <div className="space-y-1">
                        <p className={`text-[10px] font-black uppercase tracking-widest leading-none
                          ${room.status === 'available' ? (hasReservation ? 'text-amber-400' : 'text-white/30') : room.status === 'maintenance' ? 'text-red-400' : 'text-indigo-200'}`}>
                          {room.type}
                        </p>
                        {room.status === 'occupied' ? (
                          (() => {
                            const booking = bookings.find(b => b.id === room.currentBookingId && b.status === 'active');
                            if (!booking) return null;
                            const billing = calculateBilling(booking.checkInTime, room.pricePerHour);
                            return (
                              <div className="mt-2 space-y-1">
                                <div className="flex items-center gap-1.5 text-white/40">
                                  <Clock className="w-3 h-3" />
                                  <span className="text-[10px] font-bold uppercase">{billing.durationStr} uso</span>
                                </div>
                                <p className="text-xl font-black text-white leading-tight">
                                  {billing.totalAmount.toLocaleString()} <span className="text-[10px]">Kz</span>
                                </p>
                              </div>
                            );
                          })()
                        ) : (
                          <p className={`text-xl font-black mt-1
                            ${room.status === 'available' ? 'text-white' : 'text-white'}`}>
                            {room.pricePerHour.toLocaleString()} <span className="text-sm opacity-50 font-medium">Kz/h</span>
                          </p>
                        )}
                      </div>

                      <div className={`mt-4 py-2 px-3 rounded-xl text-[10px] font-black uppercase tracking-tighter text-center
                        ${room.status === 'available' ? (hasReservation ? 'bg-amber-500/20 text-amber-400' : 'bg-emerald-500/20 text-emerald-400') : room.status === 'maintenance' ? 'bg-red-500/20 text-red-400' : 'bg-white/10 text-white/40'}`}>
                        {room.status === 'available' ? (hasReservation ? 'Reservado Online' : 'Disponível') : room.status === 'occupied' ? 'Em Uso' : room.status === 'cleaning' ? 'Em Limpeza' : 'Manutenção'}
                      </div>
                    </motion.button>
                  );
                })}
              </AnimatePresence>
            </div>

            {/* Reservations Manager Section */}
            <ReservationsManager 
              reservations={reservations} 
              isAdmin={isAdmin}
              onCheckIn={(res) => {
                const room = rooms.find(r => r.id === res.roomId);
                if (room) {
                  setSelectedRoom(room);
                  setGuestForm({ name: res.guestName, phone: res.guestPhone, documentNumber: '' });
                  setIsRegistering(true);
                }
              }} 
            />

            {/* History Section */}
            <section className="mt-12 bg-white/5 rounded-[3rem] border border-white/5 overflow-hidden shadow-sm">
              <div className="px-10 py-8 bg-white/5 border-b border-white/5 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="bg-white/5 p-3 rounded-2xl">
                    <Calendar className="w-6 h-6 text-indigo-400" />
                  </div>
                  <div>
                    <h3 className="text-xl font-black text-white tracking-tight">Histórico Recente</h3>
                    <p className="text-xs text-white/30 font-bold uppercase tracking-wider">Últimas estadias encerradas</p>
                  </div>
                </div>
              </div>
          
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-white/5">
                      <th className="px-10 py-5 text-[10px] font-black uppercase tracking-widest text-white/30">Quarto</th>
                      <th className="px-10 py-5 text-[10px] font-black uppercase tracking-widest text-white/30">Hóspede</th>
                      <th className="px-10 py-5 text-[10px] font-black uppercase tracking-widest text-white/30">Cartão</th>
                      <th className="px-10 py-5 text-[10px] font-black uppercase tracking-widest text-white/30">Período</th>
                      <th className="px-10 py-5 text-[10px] font-black uppercase tracking-widest text-white/30">Custo Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {bookings
                      .filter(b => b.status === 'completed')
                      .sort((a, b) => new Date(b.checkOutTime!).getTime() - new Date(a.checkOutTime!).getTime())
                      .slice(0, 10)
                      .map(booking => {
                        const room = rooms.find(r => r.id === booking.roomId);
                        const guest = guests.find(g => g.id === booking.guestId);
                        return (
                          <tr key={booking.id} className="hover:bg-white/5 transition-colors">
                            <td className="px-10 py-4">
                              <span className="bg-indigo-500/10 text-indigo-400 px-3 py-1.5 rounded-xl font-black text-sm">
                                {room?.number || '??'}
                              </span>
                            </td>
                            <td className="px-10 py-4">
                              <p className="font-bold text-white">{guest?.name || '---'}</p>
                              <p className="text-[10px] text-white/30 font-bold">{guest?.phone || ''}</p>
                            </td>
                            <td className="px-10 py-4 font-mono text-xs font-bold text-white/20">
                              {booking.cardId}
                            </td>
                            <td className="px-10 py-4">
                              <div className="flex items-center gap-2">
                                <Clock className="w-3 h-3 text-emerald-400" />
                                <span className="font-bold text-white/60 text-sm">{booking.totalHours}h</span>
                              </div>
                              <p className="text-[10px] text-white/20 font-medium">Saída: {new Date(booking.checkOutTime!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                            </td>
                            <td className="px-10 py-4">
                              <span className="font-black text-white">
                                {booking.totalAmount?.toLocaleString()} <span className="text-[10px]">Kz</span>
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </section>
          </>
          )
        )}
      </main>

      {/* Modals Container */}
      <AnimatePresence>
        {/* Check-in Modal */}
        {(isRegistering && selectedRoom) && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={closeModal} className="absolute inset-0 bg-black/80 backdrop-blur-sm" 
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 40 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 40 }}
              className="bg-slate-900 rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden relative border border-white/10"
            >
              <div className="bg-indigo-600 px-8 py-10 text-white relative">
                <button onClick={closeModal} className="absolute top-6 right-6 p-2.5 hover:bg-white/10 rounded-full transition-colors"><X className="w-5 h-5" /></button>
                <div className="flex items-center gap-5">
                  <div className="bg-white/10 p-4 rounded-3xl backdrop-blur-sm shadow-xl shadow-black/10">
                    <Smartphone className="w-8 h-8" />
                  </div>
                  <div>
                    <h2 className="text-3xl font-black tracking-tight">Check-in</h2>
                    <p className="text-indigo-100 font-bold text-sm">Quarto {selectedRoom.number} • {selectedRoom.type}</p>
                  </div>
                </div>
              </div>

              <form onSubmit={handleCheckIn} className="p-8 space-y-8">
                <div className="space-y-4">
                  <label className="text-xs font-black uppercase tracking-widest text-white/40 flex items-center justify-between">
                    Autenticação de Chave
                    {tempSwipedCard && <span className="bg-emerald-500/10 text-emerald-400 px-2 py-0.5 rounded text-[8px] animate-pulse">AGUARDANDO LEITURA...</span>}
                  </label>
                  {!tempSwipedCard ? (
                    <div 
                      className="w-full h-40 border-4 border-dashed border-indigo-500/20 bg-indigo-500/5 rounded-[2rem] flex flex-col items-center justify-center gap-4 transition-all"
                    >
                      {isSwiping ? (
                        <div className="text-center">
                          <motion.div animate={{ scale: [1, 1.2, 1], opacity: [1, 0.5, 1] }} transition={{ repeat: Infinity }} className="w-16 h-16 bg-indigo-500/10 border-4 border-indigo-500/20 rounded-full flex items-center justify-center mx-auto mb-3">
                            <Wifi className="w-8 h-8 text-indigo-400 animate-pulse" />
                          </motion.div>
                          <p className="text-sm font-black text-indigo-400 tracking-tight">PROCESSANDO...</p>
                        </div>
                      ) : (
                        <div className="text-center">
                          <div className="w-16 h-16 bg-white/5 border-4 border-white/10 rounded-full flex items-center justify-center mx-auto mb-3 shadow-sm">
                            <Cpu className="w-8 h-8 text-white/20" />
                          </div>
                          <p className="text-sm font-black text-indigo-400/60 uppercase tracking-widest">Aproxime o Cartão</p>
                          <p className="text-[10px] text-white/10 font-bold mt-1">O SISTEMA ESTÁ OUVINDO SEU LEITOR RFID</p>
                          <button type="button" onClick={simulateSwipe} className="mt-4 text-[9px] font-black text-indigo-400 underline underline-offset-4 opacity-40 hover:opacity-100">SIMULAR (TESTE)</button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="w-full p-6 bg-emerald-500/10 border-2 border-emerald-500/20 rounded-[2rem] flex items-center justify-between shadow-lg shadow-emerald-500/10">
                      <div className="flex items-center gap-4">
                        <div className="bg-emerald-500 p-3 rounded-2xl shadow-lg shadow-emerald-500/20">
                          <CheckCircle2 className="w-6 h-6 text-white" />
                        </div>
                        <div>
                          <p className="text-[10px] font-black text-emerald-400 uppercase tracking-widest">Acesso Autorizado</p>
                          <p className="text-lg font-mono font-bold text-emerald-100 tracking-tighter">{tempSwipedCard}</p>
                        </div>
                      </div>
                      <button type="button" onClick={() => setTempSwipedCard(null)} className="bg-white/5 p-2 rounded-xl text-emerald-400 transition-colors hover:bg-emerald-500/20"><X className="w-5 h-5" /></button>
                    </motion.div>
                  )}
                </div>

                <div className="space-y-5">
                  <div className="relative">
                    <User className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-white/20" />
                    <input required value={guestForm.name} onChange={e => setGuestForm({...guestForm, name: e.target.value})} placeholder="NOME DO HÓSPEDE" className="w-full pl-12 pr-6 py-4 bg-white/5 border-2 border-transparent focus:border-indigo-600 rounded-2xl outline-none transition-all font-bold text-white placeholder:text-white/10 placeholder:font-black placeholder:text-[10px] placeholder:tracking-[0.2em]" />
                  </div>
                  <div className="relative">
                    <Phone className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-white/20" />
                    <input required value={guestForm.phone} onChange={e => setGuestForm({...guestForm, phone: e.target.value})} placeholder="TEL. PARA CONTATO" className="w-full pl-12 pr-6 py-4 bg-white/5 border-2 border-transparent focus:border-indigo-600 rounded-2xl outline-none transition-all font-bold text-white placeholder:text-white/10 placeholder:font-black placeholder:text-[10px] placeholder:tracking-[0.2em]" />
                  </div>
                  <div className="relative">
                    <FileText className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-white/20" />
                    <input value={guestForm.documentNumber} onChange={e => setGuestForm({...guestForm, documentNumber: e.target.value})} placeholder="DOCUMENTO (OPCIONAL)" className="w-full pl-12 pr-6 py-4 bg-white/5 border-2 border-transparent focus:border-indigo-600 rounded-2xl outline-none transition-all font-bold text-white placeholder:text-white/10 placeholder:font-black placeholder:text-[10px] placeholder:tracking-[0.2em]" />
                  </div>
                </div>

                <div className="flex flex-col gap-3">
                  <button type="submit" disabled={!tempSwipedCard || !guestForm.name || !guestForm.phone} className="w-full bg-indigo-600 text-white py-5 rounded-[2rem] font-black uppercase tracking-widest shadow-2xl shadow-indigo-500/20 hover:bg-indigo-700 transition-all active:scale-95 disabled:grayscale">Iniciar Estadia</button>
                  {isAdmin && (
                    <button 
                      type="button" 
                      onClick={async () => {
                        try {
                          await updateDoc(doc(db, 'rooms', selectedRoom.id), { status: 'maintenance' });
                          closeModal();
                        } catch (err) {
                          console.error(err);
                        }
                      }}
                      className="w-full bg-red-500/10 text-red-500 py-3 rounded-2xl font-black uppercase tracking-widest text-[10px] hover:bg-red-600 hover:text-white transition-all border border-red-500/20"
                    >
                      Colocar em Manutenção (STOP)
                    </button>
                  )}
                </div>
              </form>
            </motion.div>
          </div>
        )}

        {/* Maintenance / STOP Modal */}
        {(isRegistering && selectedRoom?.status === 'maintenance') && (
           <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={closeModal} className="absolute inset-0 bg-slate-900/60 backdrop-blur-md"
            />
            
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 40 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 40 }}
              className="bg-slate-900 rounded-[3rem] shadow-2xl w-full max-sm overflow-hidden relative border border-white/10"
            >
              <div className="bg-red-600 px-8 py-10 text-white relative text-center">
                 <button onClick={closeModal} className="absolute top-6 right-6 p-2 rounded-full hover:bg-white/10 transition-colors"><X className="w-5 h-5" /></button>
                 <ShieldAlert className="w-12 h-12 mx-auto mb-4" />
                 <h2 className="text-2xl font-black tracking-tight">Quarto Bloqueado</h2>
                 <p className="text-red-100 font-bold text-sm tracking-tight tracking-widest uppercase">Em Manutenção</p>
              </div>
              <div className="p-8 text-center">
                <p className="text-white/40 font-medium mb-8">Este quarto está atualmente em manutenção e não pode ser ocupado por hóspedes.</p>
                {isAdmin && (
                  <button 
                    onClick={async () => {
                      if (!selectedRoom) return;
                      try {
                        await updateDoc(doc(db, 'rooms', selectedRoom.id), { status: 'available' });
                        closeModal();
                      } catch (err) { console.error(err); }
                    }}
                    className="w-full bg-emerald-600 text-white py-5 rounded-[2rem] font-black uppercase tracking-widest shadow-xl shadow-emerald-500/20 hover:bg-emerald-700 transition-all"
                  >
                    Liberar Quarto
                  </button>
                )}
                {!isAdmin && (
                  <button onClick={closeModal} className="w-full bg-white/5 text-white/20 py-4 rounded-[2rem] font-black uppercase tracking-widest text-xs hover:bg-white/10 transition-all">Voltar</button>
                )}
              </div>
            </motion.div>
          </div>
        )}
         {/* Check-out Modal */}
        {(isCheckingOut && selectedRoom && activeBooking) && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={closeModal} className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            />
            
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 40 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 40 }}
              className="bg-slate-900 rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden relative border border-white/10"
            >
              <div className="bg-emerald-600 px-8 py-12 text-white relative text-center">
                <button onClick={closeModal} className="absolute top-6 right-6 p-2 rounded-full hover:bg-white/10 transition-colors"><X className="w-5 h-5" /></button>
                <div className="bg-white/10 w-20 h-20 rounded-[2rem] flex items-center justify-center mx-auto mb-6 backdrop-blur-sm shadow-xl shadow-black/10">
                  <LogOut className="w-10 h-10" />
                </div>
                <h2 className="text-3xl font-black tracking-tight">Checkout</h2>
                <p className="text-emerald-100 font-bold text-sm tracking-tight">Quarto {selectedRoom.number} em encerramento</p>
              </div>

              <div className="p-8 space-y-8">
                <div className="space-y-4">
                   <div className="grid grid-cols-1 gap-3">
                    <div className="px-4 py-3 bg-white/5 rounded-2xl border border-white/5">
                      <p className="text-[10px] font-black text-white/30 uppercase tracking-wider mb-1">Hóspede / Telefone</p>
                      <p className="font-black text-white truncate">{guests.find(g => g.id === activeBooking.guestId)?.name || 'Anônimo'}</p>
                      <p className="text-xs font-bold text-indigo-400">{guests.find(g => g.id === activeBooking.guestId)?.phone || 'Sem telefone'}</p>
                    </div>
                    
                    <div className="flex justify-between items-center px-4 py-3 bg-white/5 rounded-2xl border border-white/5">
                      <div className="flex items-center gap-2">
                        <CreditCard className="w-4 h-4 text-white/20" />
                        <span className="text-[10px] font-black text-white/20 uppercase tracking-wider">ID do Cartão</span>
                      </div>
                      <span className="font-mono font-bold text-white text-sm tracking-tighter">{activeBooking.cardId}</span>
                    </div>

                    <div className="flex justify-between items-center px-4 py-3 bg-white/5 rounded-2xl border border-white/5">
                      <div className="flex items-center gap-2">
                        <Calendar className="w-4 h-4 text-white/20" />
                        <span className="text-[10px] font-black text-white/20 uppercase tracking-wider">Entrada</span>
                      </div>
                      <span className="font-black text-white">{new Date(activeBooking.checkInTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                  </div>
                  
                  <div className="bg-indigo-500/5 rounded-[2.5rem] p-6 space-y-4 border border-indigo-500/10">
                    <div className="flex justify-between items-center">
                      <span className="text-[10px] font-black text-indigo-400/60 uppercase tracking-widest">Duração Real</span>
                      <span className="font-mono font-bold text-indigo-100">{calculateBilling(activeBooking.checkInTime, selectedRoom.pricePerHour).durationStr}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-[10px] font-black text-indigo-400/60 uppercase tracking-widest">Cobradas (Arred.)</span>
                      <span className="text-lg font-black text-indigo-400">{calculateBilling(activeBooking.checkInTime, selectedRoom.pricePerHour).totalHours}h</span>
                    </div>
                    <div className="pt-4 border-t border-white/10 flex justify-between items-end">
                      <span className="font-black text-white uppercase text-[11px] tracking-tighter mb-1">Total Final</span>
                      <span className="text-3xl font-black text-white tracking-tighter">{calculateBilling(activeBooking.checkInTime, selectedRoom.pricePerHour).totalAmount.toLocaleString()} <span className="text-lg">Kz</span></span>
                    </div>
                  </div>

                  <div className="flex gap-3 bg-white/5 p-4 rounded-2xl border border-white/5">
                    <Info className="w-4 h-4 text-white/20 shrink-0 mt-0.5" />
                    <p className="text-[10px] font-bold text-white/40 leading-tight">Billing Policy: Cobrança integral por hora iniciada. Taxa mínima de 1h.</p>
                  </div>
                </div>

                <div className="flex flex-col gap-3">
                  <button onClick={handleCheckOut} className="w-full bg-emerald-600 text-white py-5 rounded-[2rem] font-black uppercase tracking-widest shadow-2xl shadow-emerald-500/20 hover:bg-emerald-700 transition-all active:scale-95">Liquidado & Liberar</button>
                  <button onClick={closeModal} className="w-full bg-white/5 text-white/20 py-3 rounded-2xl font-black uppercase tracking-widest text-[10px] hover:text-white transition-colors">Aguardar Pagamento</button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

function GuestReservationView({ rooms, reservations, onSuccess }: { rooms: Room[], reservations: Reservation[], onSuccess: () => void }) {
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null);
  const [form, setForm] = useState({ name: '', phone: '', arrivalTime: '' });
  const [isPaying, setIsPaying] = useState(false);
  const [paid, setPaid] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  const availableRooms = rooms.filter(r => r.status === 'available' && !reservations.some(res => res.roomId === r.id && res.status === 'confirmed'));

  const reservePrice = selectedRoom ? selectedRoom.pricePerHour * 1.1 : 0;
  const deposit = reservePrice * 0.1;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRoom || !paid || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await addDoc(collection(db, 'reservations'), {
        roomId: selectedRoom.id,
        guestName: form.name,
        guestPhone: form.phone,
        arrivalTime: new Date(form.arrivalTime).toISOString(),
        depositPaid: deposit,
        status: 'confirmed',
        createdAt: new Date().toISOString()
      });
      setShowSuccess(true);
      setTimeout(() => {
        onSuccess();
      }, 3000);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'reservations');
    } finally {
      setIsSubmitting(false);
    }
  };

  const simulatePayment = () => {
    if (!selectedRoom || !form.arrivalTime) return;
    const arrival = new Date(form.arrivalTime);
    if (arrival < new Date()) {
      alert("A data de chegada não pode ser no passado.");
      return;
    }

    setIsPaying(true);
    setTimeout(() => {
      setIsPaying(false);
      setPaid(true);
    }, 2000);
  };

  if (showSuccess) {
    return (
      <div className="max-w-md mx-auto py-20 text-center space-y-8 animate-in fade-in zoom-in duration-500">
        <div className="bg-emerald-500 w-24 h-24 rounded-[3rem] flex items-center justify-center mx-auto shadow-2xl shadow-emerald-500/20">
          <CheckCircle2 className="text-white w-12 h-12" />
        </div>
        <div>
          <h2 className="text-3xl font-black text-white tracking-tight mb-2">Reserva Confirmada!</h2>
          <p className="text-white/40 font-medium">Sua vaga está garantida. Apresente seu telefone e nome na recepção na hora da chegada.</p>
        </div>
        <div className="bg-white/5 p-6 rounded-[2rem] border border-white/5 italic text-sm text-white/20">
          Redirecionando em instantes...
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto mb-20 animate-in fade-in slide-in-from-bottom-4 duration-500 px-4 md:px-0">
      <div className="bg-slate-900 rounded-[3rem] p-12 text-white mb-12 shadow-2xl shadow-indigo-500/10 flex flex-col md:flex-row items-center gap-10 border border-white/5">
        <div className="bg-white/10 p-6 rounded-[2.5rem] backdrop-blur-xl">
          <Calendar className="w-16 h-16 text-indigo-400" />
        </div>
        <div className="text-center md:text-left">
          <h2 className="text-4xl font-black tracking-tight mb-2">Agendamento Online</h2>
          <p className="text-indigo-400 font-bold uppercase tracking-widest text-[10px]">Portal do Hóspede • Garantia de Vaga</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
        <div className="space-y-8">
          <section>
            <h3 className="text-sm font-black uppercase tracking-widest text-white/30 mb-6 px-2 text-center md:text-left">1. Escolha seu Quarto</h3>
            {availableRooms.length === 0 ? (
              <div className="bg-white/5 p-12 rounded-[3rem] border border-white/5 text-center shadow-sm">
                <AlertCircle className="w-10 h-10 text-amber-500 mx-auto mb-4" />
                <p className="font-black text-white mb-1 leading-tight text-lg">Nenhum quarto disponível agora</p>
                <p className="text-xs font-bold text-white/20 uppercase tracking-widest">Tente novamente em alguns minutos</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                {availableRooms.map(room => (
                  <button
                    key={room.id}
                    onClick={() => { setSelectedRoom(room); setPaid(false); }}
                    className={`p-6 rounded-[2rem] border-2 text-left transition-all relative overflow-hidden group
                      ${selectedRoom?.id === room.id ? 'bg-indigo-600 border-indigo-600 text-white shadow-xl shadow-indigo-500/20' : 'bg-white/5 border-white/5 hover:border-indigo-500 text-white/60'}
                    `}
                  >
                    <p className={`text-[10px] font-black uppercase tracking-widest mb-1 ${selectedRoom?.id === room.id ? 'text-indigo-200' : 'text-white/20'}`}>{room.type}</p>
                    <p className="text-xl font-black leading-none mb-4">{room.number}</p>
                    <p className="font-bold text-lg">{(room.pricePerHour * 1.1).toLocaleString()} <span className="text-[10px]">Kz/h</span></p>
                    <p className={`text-[9px] font-black uppercase tracking-tighter mt-1 opacity-60 ${selectedRoom?.id === room.id ? 'text-white' : 'text-white/20'}`}>+10% taxa de agendamento</p>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>

        <div>
          <form onSubmit={handleSubmit} className="bg-slate-900 p-10 rounded-[3rem] border border-white/5 shadow-xl space-y-6">
            <h3 className="text-sm font-black uppercase tracking-widest text-white/30 mb-2">2. Suas Informações</h3>
            
            <div className="space-y-4">
              <input 
                required 
                placeholder="NOME COMPLETO" 
                value={form.name}
                onChange={e => setForm({...form, name: e.target.value})}
                className="w-full px-6 py-4 bg-white/5 border-2 border-transparent focus:border-indigo-600 rounded-2xl outline-none transition-all font-bold text-white placeholder:text-white/10" 
              />
              <input 
                required 
                placeholder="TELEFONE" 
                value={form.phone}
                onChange={e => setForm({...form, phone: e.target.value})}
                className="w-full px-6 py-4 bg-white/5 border-2 border-transparent focus:border-indigo-600 rounded-2xl outline-none transition-all font-bold text-white placeholder:text-white/10" 
              />
              <div>
                <label className="text-[10px] font-black text-white/20 uppercase tracking-widest ml-4 block mb-2">Previsão de Chegada</label>
                <input 
                  required 
                  type="datetime-local" 
                  value={form.arrivalTime}
                  onChange={e => setForm({...form, arrivalTime: e.target.value})}
                  className="w-full px-6 py-4 bg-white/5 border-2 border-transparent focus:border-indigo-600 rounded-2xl outline-none transition-all font-bold text-white [color-scheme:dark]" 
                />
              </div>
            </div>

            {selectedRoom && (
              <div className="bg-emerald-500/10 rounded-2xl p-6 border border-emerald-500/20">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-[10px] font-black text-emerald-400 uppercase tracking-widest">Reserva Antecipada (10%)</span>
                  <span className="text-lg font-black text-emerald-100">{deposit.toLocaleString()} Kz</span>
                </div>
                <p className="text-[10px] font-medium text-emerald-400/60 leading-tight">Valor para garantir a vaga. O restante será pago proporcionalmente no check-out.</p>
              </div>
            )}

            {!paid ? (
              <button 
                type="button"
                disabled={!selectedRoom || isPaying || !form.name || !form.phone || !form.arrivalTime}
                onClick={simulatePayment}
                className="w-full bg-white text-black py-5 rounded-[2rem] font-black uppercase tracking-widest shadow-xl transition-all hover:bg-indigo-600 hover:text-white active:scale-95 disabled:grayscale"
              >
                {isPaying ? 'Processando...' : 'Pagar Reserva'}
              </button>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center gap-3 justify-center text-emerald-400 font-black uppercase tracking-widest text-xs">
                  <CheckCircle2 className="w-5 h-5" /> Pagamento Confirmado
                </div>
                <button 
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full bg-indigo-600 text-white py-5 rounded-[2rem] font-black uppercase tracking-widest shadow-xl shadow-indigo-500/20 hover:bg-white hover:text-black transition-all disabled:opacity-50"
                >
                  {isSubmitting ? 'Confirmando...' : 'Confirmar Reserva'}
                </button>
              </div>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}

function AdminMasterPanel({ rooms, bookings, guests, reservations, staff, onCheckIn }: { 
  rooms: Room[], 
  bookings: Booking[], 
  guests: Guest[], 
  reservations: Reservation[],
  staff: Staff[],
  onCheckIn: (res: Reservation) => void
}) {
  const [editingRoom, setEditingRoom] = useState<string | null>(null);
  const [newPrice, setNewPrice] = useState<number>(0);
  const [staffForm, setStaffForm] = useState({ name: '', email: '', role: 'receptionist' as 'receptionist' | 'manager' });
  const [isAddingStaff, setIsAddingStaff] = useState(false);

  const totalRevenue = bookings
    .filter(b => b.status === 'completed')
    .reduce((sum, b) => sum + (b.totalAmount || 0), 0);

  const totalReservationsPaid = reservations
    .filter(r => r.status !== 'cancelled')
    .reduce((sum, r) => sum + r.depositPaid, 0);

  const stats = [
    { label: 'Receita Total', value: `${(totalRevenue + totalReservationsPaid).toLocaleString()} Kz`, icon: TrendingUp, color: 'emerald' },
    { label: 'Taxa de Ocupação', value: `${Math.round((rooms.filter(r => r.status === 'occupied').length / rooms.length) * 100)}%`, icon: Hotel, color: 'indigo' },
    { label: 'Hóspedes Totais', value: guests.length, icon: User, color: 'slate' },
    { label: 'Reservas Ativas', value: reservations.filter(r => r.status === 'confirmed').length, icon: Calendar, color: 'amber' }
  ];

  const handlePriceUpdate = async (roomId: string) => {
    try {
      await updateDoc(doc(db, 'rooms', roomId), { pricePerHour: newPrice });
      setEditingRoom(null);
    } catch (err) {
      console.error(err);
    }
  };

  const toggleMaintenance = async (room: Room) => {
    try {
      const newStatus = room.status === 'maintenance' ? 'available' : 'maintenance';
      await updateDoc(doc(db, 'rooms', room.id), { status: newStatus });
    } catch (err) {
      console.error(err);
    }
  };

  const deleteRecord = async (bookingId: string) => {
    if (!window.confirm('Excluir este registro permanentemente?')) return;
    try {
      await deleteDoc(doc(db, 'bookings', bookingId));
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Admin Hero */}
      <div className="bg-slate-900 rounded-[3rem] p-12 text-white relative overflow-hidden shadow-2xl border border-white/10">
        <div className="absolute top-0 right-0 w-96 h-96 bg-indigo-500/5 rounded-full -mr-48 -mt-48 blur-3xl" />
        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-8">
          <div>
            <div className="flex items-center gap-3 mb-4">
              <span className="bg-indigo-600 text-white text-[10px] font-black px-3 py-1 rounded-full uppercase tracking-widest shadow-lg shadow-indigo-500/20">Acesso Master</span>
              <span className="text-white/30 text-xs font-bold uppercase tracking-wider">Monitor de Alta Gestão</span>
            </div>
            <h2 className="text-5xl font-black tracking-tighter mb-2 text-white">Painel Adm Master</h2>
            <p className="text-white/40 text-lg font-medium max-w-md">Controle total de preços, inventário e registros financeiros do estabelecimento.</p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            {stats.slice(0, 2).map((s, i) => (
              <div key={i} className="bg-white/5 p-6 rounded-[2.5rem] border border-white/5 shadow-sm">
                <s.icon className={`w-6 h-6 mb-3 ${s.color === 'emerald' ? 'text-emerald-400' : 'text-indigo-400'}`} />
                <p className="text-[10px] font-black uppercase tracking-widest text-white/20 mb-1">{s.label}</p>
                <p className="text-2xl font-black tracking-tighter text-white">{s.value}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Staff Management */}
      <section className="bg-slate-900 rounded-[3rem] border border-white/5 shadow-sm overflow-hidden">
        <div className="px-10 py-8 bg-white/5 border-b border-white/5 flex items-center justify-between">
          <h3 className="font-black text-white text-xl tracking-tight flex items-center gap-3">
            <User className="text-indigo-400 w-6 h-6" /> Gerenciar Equipe
          </h3>
          <span className="bg-indigo-600 text-white px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest shadow-lg shadow-indigo-500/20">Apenas Adm Master</span>
        </div>
        
        <div className="p-10 space-y-8">
          <form 
            onSubmit={async (e) => {
              e.preventDefault();
              setIsAddingStaff(true);
              try {
                // We add to staff collection. The person will need to sign up/login with this email.
                await setDoc(doc(db, 'staff', staffForm.email), {
                  name: staffForm.name,
                  email: staffForm.email,
                  role: staffForm.role,
                  createdAt: new Date().toISOString()
                });
                setStaffForm({ name: '', email: '', role: 'receptionist' });
                alert("Funcionário autorizado com sucesso!");
              } catch (err) {
                console.error(err);
                alert("Erro ao autorizar funcionário.");
              } finally {
                setIsAddingStaff(false);
              }
            }}
            className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end bg-white/5 p-6 rounded-[2rem] border border-white/5"
          >
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-white/20 ml-4">Nome</label>
              <input 
                required 
                value={staffForm.name}
                onChange={e => setStaffForm({...staffForm, name: e.target.value})}
                className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl outline-none font-bold text-sm text-white placeholder:text-white/10" 
              />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-white/20 ml-4">E-mail</label>
              <input 
                required 
                type="email"
                value={staffForm.email}
                onChange={e => setStaffForm({...staffForm, email: e.target.value})}
                className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl outline-none font-bold text-sm text-white placeholder:text-white/10" 
              />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-white/20 ml-4">Cargo</label>
              <select 
                value={staffForm.role}
                onChange={e => setStaffForm({...staffForm, role: e.target.value as any})}
                className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl outline-none font-bold text-sm text-white [color-scheme:dark]"
              >
                <option value="receptionist" className="bg-slate-900">Recepcionista</option>
                <option value="manager" className="bg-slate-900">Gerente</option>
              </select>
            </div>
                <button 
              type="submit" 
              disabled={isAddingStaff}
              className="bg-indigo-600 text-white py-3 rounded-xl font-black uppercase tracking-widest text-xs hover:bg-slate-800 transition-all disabled:opacity-50 shadow-lg shadow-indigo-500/20"
            >
              {isAddingStaff ? "Salvando..." : "Autorizar Acesso"}
            </button>
          </form>
          
          <div className="bg-white/5 border border-white/5 p-6 rounded-2xl flex items-start gap-4">
            <div className="bg-indigo-500/10 p-2 rounded-xl text-indigo-400">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div>
              <p className="text-sm font-black text-white">Como funciona o primeiro acesso?</p>
              <p className="text-xs text-white/30 font-medium leading-relaxed mt-1">
                O funcionário deve logar com o e-mail cadastrado e a senha padrão <code className="bg-white/5 px-1.5 py-0.5 rounded border border-white/5 font-black text-indigo-400">123456</code>. 
                O sistema criará a conta dele automaticamente no primeiro login. Ele deve alterar a senha no perfil após entrar.
              </p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-white/40">Nome</th>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-white/40">E-mail</th>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-white/40">Cargo</th>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-white/40 text-right">Ação</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {staff.map(member => (
                  <tr key={member.id} className="hover:bg-white/5 transition-colors">
                    <td className="px-6 py-4 font-bold text-white">{member.name}</td>
                    <td className="px-6 py-4 text-sm text-white/40 font-mono">{member.email}</td>
                    <td className="px-6 py-4">
                      <span className="bg-white/5 text-white/60 px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest border border-white/5">
                        {member.role === 'receptionist' ? 'Recepção' : 'Gerência'}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <button 
                        onClick={async () => {
                          if(window.confirm(`Remover acesso de ${member.name}?`)) {
                            await deleteDoc(doc(db, 'staff', member.id));
                          }
                        }}
                        className="text-red-400 hover:text-red-500 p-2"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Room Table */}
      <section className="bg-slate-900 rounded-[3rem] border border-white/5 shadow-2xl overflow-hidden">
        <div className="px-10 py-8 bg-white/5 border-b border-white/5 flex items-center justify-between">
          <h3 className="font-black text-white text-xl tracking-tight flex items-center gap-3">
            <Hotel className="text-indigo-400 w-6 h-6" /> Gestão de Quartos
          </h3>
          <span className="bg-indigo-500/10 text-indigo-400 px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border border-indigo-500/10">Ajuste de Preços & Status</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-white/5 bg-white/5">
                <th className="px-10 py-5 text-[10px] font-black uppercase tracking-widest text-white/40">Nº / Tipo</th>
                <th className="px-10 py-5 text-[10px] font-black uppercase tracking-widest text-white/40">Preço / Hora</th>
                <th className="px-10 py-5 text-[10px] font-black uppercase tracking-widest text-white/40">Status Atual</th>
                <th className="px-10 py-5 text-[10px] font-black uppercase tracking-widest text-white/40 text-right">Ação</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rooms.map(room => (
                <tr key={room.id} className="hover:bg-white/5 transition-colors">
                  <td className="px-10 py-6">
                    <p className="font-black text-white text-lg">Quarto {room.number}</p>
                    <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest">{room.type}</p>
                  </td>
                  <td className="px-10 py-6">
                    {editingRoom === room.id ? (
                      <div className="flex items-center gap-2">
                        <input 
                          autoFocus
                          type="number" 
                          value={newPrice} 
                          onChange={e => setNewPrice(Number(e.target.value))}
                          className="w-24 px-3 py-2 bg-white/5 border-2 border-indigo-600 rounded-xl outline-none font-black text-sm text-white"
                        />
                        <button onClick={() => handlePriceUpdate(room.id)} className="bg-indigo-600 text-white p-2 rounded-xl hover:bg-slate-800 transition-colors"><CheckCircle2 className="w-4 h-4" /></button>
                        <button onClick={() => setEditingRoom(null)} className="text-white/20 p-2"><X className="w-4 h-4" /></button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        <span className="font-black text-white text-lg">{room.pricePerHour.toLocaleString()} <span className="text-xs text-white/40">Kz</span></span>
                        <button 
                          onClick={() => { setEditingRoom(room.id); setNewPrice(room.pricePerHour); }}
                          className="p-1.5 text-white/20 hover:text-indigo-400 transition-colors"
                        >
                          <Settings className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="px-10 py-6">
                    <span className={`px-3 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-widest border
                      ${room.status === 'available' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 
                        room.status === 'occupied' ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20' : 
                        room.status === 'maintenance' ? 'bg-red-500/10 text-red-500 border-red-500/20' : 'bg-white/5 text-white/40 border-white/5'}
                    `}>
                      {room.status === 'available' ? 'Ativo / Livre' : 
                       room.status === 'occupied' ? 'Hóspede Presente' : 
                       room.status === 'maintenance' ? 'Em Manutenção (STOP)' : 'Em Limpeza'}
                    </span>
                  </td>
                  <td className="px-10 py-6 text-right">
                    <button 
                      onClick={() => toggleMaintenance(room)}
                      disabled={room.status === 'occupied'}
                      className={`px-4 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all
                        ${room.status === 'maintenance' ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-500/20' : 
                          room.status === 'occupied' ? 'bg-white/5 text-white/10 cursor-not-allowed' : 'bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-600 hover:text-white'}
                      `}
                    >
                      {room.status === 'maintenance' ? 'Liberar' : 'Stop Room'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Reservations Section */}
      <section className="bg-slate-900 rounded-[3rem] border border-white/5 shadow-2xl overflow-hidden mb-12">
        <div className="px-10 py-8 bg-white/5 border-b border-white/5 flex items-center justify-between">
          <h3 className="font-black text-white text-xl tracking-tight flex items-center gap-3">
            <Calendar className="text-amber-400 w-6 h-6" /> Reservas Pendentes / Expiradas
          </h3>
        </div>
        <div className="p-1">
          <ReservationsManager 
            reservations={reservations} 
            isAdmin={true} 
            onCheckIn={onCheckIn} 
          />
        </div>
      </section>

      {/* Logs Table */}
      <section className="bg-slate-900 rounded-[3rem] border border-white/5 shadow-2xl overflow-hidden">
        <div className="px-10 py-8 bg-white/5 border-b border-white/5 flex items-center justify-between">
          <h3 className="font-black text-xl tracking-tight flex items-center gap-3 text-white">
            <FileText className="text-indigo-400 w-6 h-6" /> Registro de Atividades
          </h3>
          <div className="flex gap-4">
             <span className="bg-white/5 border border-white/5 text-white/20 px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest">Logs de Entrada/Saída</span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-white/5 bg-white/5">
                <th className="px-10 py-5 text-[10px] font-black uppercase tracking-widest text-white/40">Entrada / Saída</th>
                <th className="px-10 py-5 text-[10px] font-black uppercase tracking-widest text-white/40">Quarto / Evento</th>
                <th className="px-10 py-5 text-[10px] font-black uppercase tracking-widest text-white/40">Hóspede</th>
                <th className="px-10 py-5 text-[10px] font-black uppercase tracking-widest text-white/40">Pagt. Reserva</th>
                <th className="px-10 py-5 text-[10px] font-black uppercase tracking-widest text-white/40">Total Consumido</th>
                <th className="px-10 py-5 text-[10px] font-black uppercase tracking-widest text-white/40 text-right">Controle</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 text-white">
              {bookings.sort((a,b) => new Date(b.checkInTime).getTime() - new Date(a.checkInTime).getTime()).map(b => {
                const room = rooms.find(r => r.id === b.roomId);
                return (
                  <tr key={b.id} className="hover:bg-white/5 transition-colors">
                    <td className="px-10 py-6">
                      <div className="space-y-1">
                        <p className="font-bold text-white flex items-center gap-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> 
                          {new Date(b.checkInTime).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                        </p>
                        {b.checkOutTime && (
                          <p className="font-bold text-white/20 flex items-center gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-red-500" /> 
                            {new Date(b.checkOutTime).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                          </p>
                        )}
                      </div>
                    </td>
                    <td className="px-10 py-6">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${b.status === 'active' ? 'bg-emerald-500 animate-pulse' : 'bg-white/10'}`} />
                        <p className="font-black text-sm text-indigo-400">Q. {room?.number}</p>
                      </div>
                      <p className="text-[10px] font-bold text-white/20 ml-4 uppercase tracking-tighter">
                        {b.status === 'active' ? 'Estadia em curso' : `Finalizado (${b.totalHours}h)`}
                      </p>
                    </td>
                    <td className="px-10 py-6">
                      <p className="font-bold text-white">{b.guestName || '??'}</p>
                      <p className="text-[10px] text-white/20 font-bold uppercase">{b.guestPhone || '--'}</p>
                    </td>
                    <td className="px-10 py-6">
                      {b.reservationDeposit ? (
                        <div>
                          <p className="font-black text-amber-400">{b.reservationDeposit.toLocaleString()} <span className="text-[10px]">Kz</span></p>
                          <p className="text-[9px] font-black uppercase text-amber-500/50">Pago no App</p>
                        </div>
                      ) : (
                        <p className="text-[10px] font-bold text-white/10 uppercase tracking-widest">---</p>
                      )}
                    </td>
                    <td className="px-10 py-6">
                      <p className="font-black text-white">{b.totalAmount?.toLocaleString() || '--'} <span className="text-[10px]">Kz</span></p>
                      {b.totalAmount && (
                         <p className="text-[9px] font-black uppercase text-emerald-500">Saldo Liquidado</p>
                      )}
                    </td>
                    <td className="px-10 py-6 text-right">
                      <button onClick={() => deleteRecord(b.id)} className="p-2 text-white/10 hover:text-red-500 hover:bg-white/5 rounded-xl transition-all">
                        <Trash2 className="w-5 h-5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

    </div>
  );
}

function ReservationsManager({ reservations, isAdmin, onCheckIn }: { reservations: Reservation[], isAdmin: boolean, onCheckIn: (res: Reservation) => void }) {
  const [search, setSearch] = useState('');

  const handleCancel = async (id: string) => {
    if (!window.confirm('Deseja realmente cancelar esta reserva?')) return;
    try {
      await updateDoc(doc(db, 'reservations', id), { status: 'cancelled' });
    } catch (err) {
      console.error(err);
    }
  };

  const filtered = reservations
    .filter(r => r.status === 'confirmed' || r.status === 'expired' || r.status === 'cancelled')
    .filter(r => r.guestName.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => new Date(a.arrivalTime).getTime() - new Date(b.arrivalTime).getTime());

  return (
    <section className="mb-16 bg-slate-900 rounded-[3rem] border border-white/5 overflow-hidden shadow-2xl">
      <div className="px-10 py-8 bg-white/5 border-b border-white/5 flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="flex items-center gap-4">
          <div className="bg-white/5 p-3 rounded-2xl shadow-sm border border-white/5 text-amber-400">
            <Calendar className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-xl font-black text-white tracking-tight">Agendamentos Online</h3>
            <p className="text-xs text-amber-500/80 font-bold uppercase tracking-wider">Aguardando Check-in</p>
          </div>
        </div>
        
        <div className="bg-white/5 p-2 rounded-2xl border border-white/10 flex items-center px-4 w-full md:w-64">
          <Search className="w-4 h-4 text-white/20 mr-2" />
          <input 
            placeholder="Pesquisar hóspede..." 
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="bg-transparent outline-none text-sm font-bold text-white w-full placeholder:text-white/10" 
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-white/5 bg-white/5">
              <th className="px-10 py-5 text-[10px] font-black uppercase tracking-widest text-white/40 text-left">Hóspede</th>
              <th className="px-10 py-5 text-[10px] font-black uppercase tracking-widest text-white/40 text-left">Chegada Prevista</th>
              <th className="px-10 py-5 text-[10px] font-black uppercase tracking-widest text-white/40 text-left">Depósito</th>
              <th className="px-10 py-5 text-[10px] font-black uppercase tracking-widest text-white/40 text-left">Status</th>
              <th className="px-10 py-5 text-[10px] font-black uppercase tracking-widest text-white/40 text-right">Ação</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {filtered.map(res => (
              <tr key={res.id} className={`hover:bg-white/5 transition-colors ${res.status === 'cancelled' ? 'opacity-30 grayscale' : ''}`}>
                <td className="px-10 py-6">
                  <p className="font-black text-white">{res.guestName}</p>
                  <p className="text-xs font-bold text-indigo-400">{res.guestPhone}</p>
                </td>
                <td className="px-10 py-6">
                  <p className="font-bold text-white/40">{new Date(res.arrivalTime).toLocaleDateString()}</p>
                  <p className="text-sm font-black text-white">{new Date(res.arrivalTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                </td>
                <td className="px-10 py-6">
                  <span className="bg-emerald-500/10 text-emerald-400 px-3 py-1.5 rounded-xl font-black text-xs border border-emerald-500/20">
                    {res.depositPaid.toLocaleString()} Kz (PAGO)
                  </span>
                </td>
                <td className="px-10 py-6">
                  <span className={`px-3 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-widest border
                    ${res.status === 'confirmed' ? 'bg-amber-500/10 text-amber-500 border-amber-500/20' : res.status === 'cancelled' ? 'bg-white/5 text-white/20 border-white/10' : 'bg-red-500/10 text-red-500 border-red-500/20'}
                  `}>
                    {res.status === 'confirmed' ? 'Pendente' : res.status === 'cancelled' ? 'Cancelado' : 'Expirado'}
                  </span>
                </td>
                <td className="px-10 py-6 text-right">
                  <div className="flex items-center justify-end gap-2">
                    {res.status === 'confirmed' && (
                      <button 
                        onClick={() => onCheckIn(res)}
                        className="bg-indigo-600 text-white px-6 py-2.5 rounded-2xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-800 transition-all shadow-lg shadow-indigo-500/20"
                      >
                        Concluir
                      </button>
                    )}
                    {(isAdmin && (res.status === 'confirmed' || res.status === 'expired')) && (
                      <button 
                        onClick={() => handleCancel(res.id)}
                        className="p-2.5 bg-red-500/10 text-red-500 rounded-xl hover:bg-red-600 hover:text-white transition-all border border-red-500/10"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="py-20 text-center">
            <Calendar className="w-12 h-12 text-white/5 mx-auto mb-4" />
            <p className="text-white/20 font-bold uppercase tracking-widest text-[10px]">Nenhuma reserva pendente encontrada</p>
          </div>
        )}
      </div>
    </section>
  );
}