/**
 * ChessradBoard Engine v1.4.0 - Editor & Study Enhanced
 */

class ChessradBoard {
    constructor(containerId, options = {}) {
        this.container = document.getElementById(containerId);
        if (!this.container) return;

        this.game = new Chess();
        this.mode = options.mode || 'game'; // 'game', 'demo', 'editor'
        this.orientation = options.orientation || 'white';
        this.sparePieces = options.sparePieces || false;
        this.selectedSquare = null;
        this.selectedSparePiece = null; // Для режима редактора
        this.shapes = options.shapes || [];
        this.onMove = options.onMove || null;
        this.isDrawing = false;
        this.startSquarePoint = null;

        this.initDOM();
        this.initEvents();
        this.render();
    }

    initDOM() {
        this.container.style.position = 'relative';
        this.container.classList.add('cr-board-wrapper');

        // Очищаем контейнер и создаем структуру с панелями для фигур
        this.container.innerHTML = `
            ${this.sparePieces ? '<div class="cr-spare-pieces-top" style="display: flex; justify-content: center; height: 50px; margin-bottom: 5px;"></div>' : ''}
            <div class="cr-board-relative" style="position: relative; width: 100%; aspect-ratio: 1/1;">
                <div class="cr-board-grid" style="display: grid; grid-template-columns: repeat(8, 1fr); width: 100%; height: 100%;"></div>
                <div class="cr-pieces-layer" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 2;"></div>
                <canvas class="cr-drawing-layer" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 3;"></canvas>
            </div>
            ${this.sparePieces ? '<div class="cr-spare-pieces-bottom" style="display: flex; justify-content: center; height: 50px; margin-top: 5px;"></div>' : ''}
        `;

        this.gridEl = this.container.querySelector('.cr-board-grid');
        this.piecesEl = this.container.querySelector('.cr-pieces-layer');
        this.canvas = this.container.querySelector('.cr-drawing-layer');
        this.ctx = this.canvas.getContext('2d');

        if (this.sparePieces) {
            this.spareTopEl = this.container.querySelector('.cr-spare-pieces-top');
            this.spareBottomEl = this.container.querySelector('.cr-spare-pieces-bottom');
        }

        this.resize();
    }

    setPosition(fen) {
        if (!this.game) return;
        if (fen === 'start' || !fen) {
            this.game.reset();
        } else {
            // Исправляем FEN если он неполный (для редактора)
            const loaded = this.game.load(fen);
            if (!loaded) {
                this.game.load(fen.split(' ')[0] + " w - - 0 1");
            }
        }
        this.render();
    }

    setOrientation(color) {
        this.orientation = color;
        this.render();
    }

    render() {
        const board = this.game.board();
        this.gridEl.innerHTML = '';
        this.piecesEl.innerHTML = '';

        const boardWrapper = this.container.querySelector('.cr-board-relative');
        this.squareSize = boardWrapper.offsetWidth / 8;

        // Рендер сетки и фигур на доске
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const displayRow = this.orientation === 'white' ? r : 7 - r;
                const displayCol = this.orientation === 'white' ? c : 7 - c;

                const squareDiv = document.createElement('div');
                const squareName = this.coordsToSquare(displayCol, displayRow);
                squareDiv.className = `cr-square ${(r + c) % 2 === 0 ? 'light' : 'dark'}`;
                squareDiv.dataset.square = squareName;
                this.gridEl.appendChild(squareDiv);

                const piece = board[displayRow][displayCol];
                if (piece) {
                    this.renderPiece(piece, squareName);
                }
            }
        }

        if (this.sparePieces) this.renderSparePieces();
        this.drawMarkup();
    }

    renderPiece(piece, square) {
        const img = document.createElement('img');
        const fileName = `${piece.color}${piece.type.toUpperCase()}.png`;
        img.src = `/img/chesspieces/wikipedia/${fileName}`;
        img.className = 'cr-piece';

        const pos = this.getSquarePosition(square);
        img.style.cssText = `
            position: absolute;
            left: ${pos.x}px;
            top: ${pos.y}px;
            width: ${this.squareSize}px;
            height: ${this.squareSize}px;
            pointer-events: none;
            z-index: 2;
        `;

        if (this.selectedSquare === square) {
            img.style.filter = 'drop-shadow(0 0 10px yellow) brightness(1.2)';
        }
        this.piecesEl.appendChild(img);
    }

    renderSparePieces() {
        const colors = ['w', 'b'];
        const types = ['P', 'N', 'B', 'R', 'Q', 'K'];

        [this.spareTopEl, this.spareBottomEl].forEach((el, idx) => {
            el.innerHTML = '';
            const color = (this.orientation === 'white') ? colors[1 - idx] : colors[idx];

            types.forEach(type => {
                const img = document.createElement('img');
                img.src = `/img/chesspieces/wikipedia/${color}${type}.png`;
                img.style.width = '45px';
                img.style.height = '45px';
                img.style.cursor = 'pointer';
                const pieceKey = `${color}${type}`;

                if (this.selectedSparePiece === pieceKey) {
                    img.style.background = 'rgba(255, 255, 0, 0.4)';
                    img.style.borderRadius = '5px';
                }

                img.onclick = () => {
                    this.selectedSparePiece = (this.selectedSparePiece === pieceKey) ? null : pieceKey;
                    this.selectedSquare = null;
                    this.render();
                };
                el.appendChild(img);
            });
        });
    }

    handleSquareClick(square) {
        if (this.mode === 'editor') {
            if (this.selectedSparePiece) {
                // Ставим выбранную фигуру
                const color = this.selectedSparePiece[0];
                const type = this.selectedSparePiece[1].toLowerCase();
                this.game.put({ type, color }, square);
            } else {
                // Удаляем фигуру кликом в редакторе если ничего не выбрано
                this.game.remove(square);
            }
            this.render();
            return;
        }

        const piece = this.game.get(square);
        if (this.selectedSquare) {
            if (this.selectedSquare === square) {
                this.selectedSquare = null;
            } else {
                this.executeMove(this.selectedSquare, square);
                return;
            }
        } else if (piece) {
            this.selectedSquare = square;
        }
        this.render();
    }

    executeMove(from, to) {
        const piece = this.game.get(from);
        let move = null;

        if (piece && piece.type === 'p' && (to[1] === '8' || to[1] === '1')) {
            move = this.game.move({ from, to, promotion: 'q' });
        } else {
            move = this.game.move({ from, to });
        }

        if (move) {
            this.finishMove(move);
        } else if (this.mode === 'demo') {
            const p = this.game.remove(from);
            this.game.put(p, to);
            this.finishMove({ from, to, san: 'forced' });
        } else {
            this.selectedSquare = null;
            this.render();
        }
    }

    finishMove(move) {
        this.selectedSquare = null;
        if (this.onMove) {
            this.onMove({
                san: move.san,
                fen: this.game.fen(),
                pgn: this.game.pgn()
            });
        }
        this.render();
    }

    coordsToSquare(c, r) {
        return String.fromCharCode(97 + c) + (8 - r);
    }

    getSquarePosition(square) {
        let col = square.charCodeAt(0) - 97;
        let row = 8 - parseInt(square[1]);
        if (this.orientation === 'black') {
            col = 7 - col;
            row = 7 - row;
        }
        return { x: col * this.squareSize, y: row * this.squareSize };
    }

    resize() {
        const boardWrapper = this.container.querySelector('.cr-board-relative');
        if (!boardWrapper) return;
        this.squareSize = boardWrapper.offsetWidth / 8;
        this.canvas.width = boardWrapper.offsetWidth;
        this.canvas.height = boardWrapper.offsetHeight;
        this.render();
    }

    initEvents() {
        this.container.addEventListener('mousedown', (e) => {
            const rect = this.container.querySelector('.cr-board-relative').getBoundingClientRect();
            if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;

            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const col = Math.floor(x / (rect.width / 8));
            const row = Math.floor(y / (rect.height / 8));

            const finalCol = this.orientation === 'white' ? col : 7 - col;
            const finalRow = this.orientation === 'white' ? row : 7 - row;
            const square = this.coordsToSquare(finalCol, finalRow);

            if (e.button === 0) { // Левый клик
                this.handleSquareClick(square);
            } else if (e.button === 2) { // Правый клик
                this.isDrawing = true;
                this.startSquarePoint = square;
            }
        });

        window.addEventListener('mouseup', (e) => {
            if (this.isDrawing && e.button === 2) {
                const rect = this.container.querySelector('.cr-board-relative').getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;

                if (x >= 0 && x <= rect.width && y >= 0 && y <= rect.height) {
                    const col = Math.floor(x / (rect.width / 8));
                    const row = Math.floor(y / (rect.height / 8));
                    const finalCol = this.orientation === 'white' ? col : 7 - col;
                    const finalRow = this.orientation === 'white' ? row : 7 - row;
                    const endSquare = this.coordsToSquare(finalCol, finalRow);

                    if (this.startSquarePoint === endSquare) {
                        const idx = this.shapes.findIndex(s => s.type === 'circle' && s.startSquare === endSquare);
                        if (idx !== -1) this.shapes.splice(idx, 1);
                        else this.shapes.push({ type: 'circle', startSquare: this.startSquarePoint });
                    } else {
                        this.shapes.push({ type: 'arrow', startSquare: this.startSquarePoint, endSquare: endSquare });
                    }
                }
                this.isDrawing = false;
                this.drawMarkup();
            }
        });

        this.container.oncontextmenu = (e) => e.preventDefault();
        window.addEventListener('resize', () => this.resize());
    }

    drawMarkup() {
        if (!this.ctx) return;
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.shapes.forEach(s => {
            const start = this.getSquarePosition(s.startSquare);
            const offset = this.squareSize / 2;
            this.ctx.strokeStyle = s.type === 'circle' ? 'rgba(46, 204, 113, 0.8)' : 'rgba(231, 76, 60, 0.8)';
            this.ctx.lineWidth = s.type === 'circle' ? 4 : 6;

            if (s.type === 'circle') {
                this.ctx.beginPath();
                this.ctx.arc(start.x + offset, start.y + offset, offset * 0.7, 0, Math.PI * 2);
                this.ctx.stroke();
            } else if (s.endSquare) {
                const end = this.getSquarePosition(s.endSquare);
                this.drawArrow(start.x + offset, start.y + offset, end.x + offset, end.y + offset);
            }
        });
    }

    drawArrow(fromx, fromy, tox, toy) {
        const headlen = 15;
        const angle = Math.atan2(toy - fromy, tox - fromx);
        this.ctx.lineCap = 'round';
        this.ctx.beginPath();
        this.ctx.moveTo(fromx, fromy);
        this.ctx.lineTo(tox, toy);
        this.ctx.stroke();
        this.ctx.beginPath();
        this.ctx.moveTo(tox, toy);
        this.ctx.lineTo(tox - headlen * Math.cos(angle - Math.PI / 6), toy - headlen * Math.sin(angle - Math.PI / 6));
        this.ctx.lineTo(tox - headlen * Math.cos(angle + Math.PI / 6), toy - headlen * Math.sin(angle + Math.PI / 6));
        this.ctx.lineTo(tox, toy);
        this.ctx.fillStyle = this.ctx.strokeStyle;
        this.ctx.fill();
    }
}
