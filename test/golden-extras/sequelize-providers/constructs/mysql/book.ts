import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Audiobook } from './audiobook.js';
import type { Author } from './author.js';
import type { Series } from './series.js';

export class Book extends Model<
  InferAttributes<Book>,
  InferCreationAttributes<Book>
> {
  declare id: CreationOptional<string>;
  declare title: string;
  declare tags: CreationOptional<string[]>;
  declare grid: CreationOptional<number[][] | null>;
  declare colors: CreationOptional<('red' | 'green')[] | null>;
  declare color: CreationOptional<'red' | 'green'>;
  declare price: CreationOptional<string>;
  declare settings: CreationOptional<unknown>;
  declare published_on: CreationOptional<string>;
  declare opens_at: CreationOptional<string | null>;
  declare released_at: CreationOptional<Date | null>;
  declare pages: CreationOptional<number>;
  declare ratio: CreationOptional<number>;
  declare in_print: CreationOptional<boolean>;
  declare notes: CreationOptional<string | null>;
  declare window: CreationOptional<string | null>;
  declare extra: CreationOptional<Record<string, string | null> | null>;
  declare read_time: CreationOptional<string | null>;
  declare cover: CreationOptional<Buffer | null>;
  declare author_id: string;
  declare editor_id: CreationOptional<string | null>;
  declare series_handle: CreationOptional<string | null>;

  declare latest_for?: NonAttribute<Author[]>;
  declare author?: NonAttribute<Author>;
  declare editor?: NonAttribute<Author>;
  declare series?: NonAttribute<Series>;
  declare audiobook?: NonAttribute<Audiobook>;

  static initModel(sequelize: Sequelize): typeof Book {
    Book.init(
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        title: { type: DataTypes.STRING(120), allowNull: false },
        tags: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
        grid: DataTypes.JSON,
        colors: DataTypes.JSON,
        color: {
          type: DataTypes.ENUM('red', 'green'),
          allowNull: false,
          defaultValue: 'red',
        },
        price: {
          type: DataTypes.DECIMAL(8, 2),
          allowNull: false,
          defaultValue: 9.99,
        },
        settings: {
          type: DataTypes.JSON,
          allowNull: false,
          defaultValue: { theme: 'dark', tabs: [1, 2] },
        },
        published_on: {
          type: DataTypes.DATEONLY,
          allowNull: false,
          defaultValue: DataTypes.NOW,
        },
        opens_at: DataTypes.TIME,
        released_at: {
          type: DataTypes.DATE,
          defaultValue: '2020-01-02T03:04:05Z',
        },
        pages: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 100 },
        ratio: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 0.5 },
        in_print: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        notes: DataTypes.TEXT,
        window: DataTypes.TEXT,
        extra: DataTypes.JSON,
        read_time: DataTypes.BIGINT,
        cover: DataTypes.BLOB,
        author_id: { type: DataTypes.UUID, allowNull: false },
        editor_id: DataTypes.UUID,
        series_handle: DataTypes.STRING(20),
      },
      {
        sequelize,
        modelName: 'Book',
        tableName: 'books',
        timestamps: false,
        indexes: [
          { unique: true, fields: ['title', 'author_id'] },
          { name: 'books_published_idx', fields: ['published_on'] },
        ],
      }
    );
    return Book;
  }
}
