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
  declare publishedOn: CreationOptional<string>;
  declare opensAt: CreationOptional<string | null>;
  declare releasedAt: CreationOptional<Date | null>;
  declare pages: CreationOptional<number>;
  declare ratio: CreationOptional<number>;
  declare inPrint: CreationOptional<boolean>;
  declare notes: CreationOptional<string | null>;
  declare window: CreationOptional<unknown | null>;
  declare extra: CreationOptional<Record<string, string | null> | null>;
  declare readTime: CreationOptional<string | null>;
  declare cover: CreationOptional<Buffer | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare authorId: string;
  declare editorId: CreationOptional<string | null>;
  declare seriesHandle: CreationOptional<string | null>;

  declare latestFor?: NonAttribute<Author[]>;
  declare author?: NonAttribute<Author>;
  declare editor?: NonAttribute<Author>;
  declare series?: NonAttribute<Series>;
  declare audiobook?: NonAttribute<Audiobook>;

  static initModel(sequelize: Sequelize): typeof Book {
    Book.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        title: { type: DataTypes.STRING(120), allowNull: false },
        tags: {
          type: DataTypes.ARRAY(DataTypes.TEXT),
          allowNull: false,
          defaultValue: [],
        },
        grid: DataTypes.ARRAY(DataTypes.ARRAY(DataTypes.INTEGER)),
        colors: DataTypes.ARRAY(DataTypes.ENUM('red', 'green')),
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
          type: DataTypes.JSONB,
          allowNull: false,
          defaultValue: { theme: 'dark', tabs: [1, 2] },
        },
        publishedOn: {
          type: DataTypes.DATEONLY,
          allowNull: false,
          defaultValue: DataTypes.NOW,
        },
        opensAt: DataTypes.TIME,
        releasedAt: {
          type: DataTypes.DATE,
          defaultValue: '2020-01-02T03:04:05Z',
        },
        pages: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 100 },
        ratio: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 0.5 },
        inPrint: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        notes: DataTypes.TEXT,
        window: DataTypes.RANGE(DataTypes.INTEGER),
        extra: DataTypes.HSTORE,
        readTime: DataTypes.BIGINT,
        cover: DataTypes.BLOB,
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        authorId: { type: DataTypes.UUID, allowNull: false },
        editorId: DataTypes.UUID,
        seriesHandle: DataTypes.STRING(20),
      },
      {
        sequelize,
        modelName: 'Book',
        tableName: 'book',
        timestamps: true,
        underscored: true,
        indexes: [
          { unique: true, fields: ['title', 'author_id'] },
          { name: 'books_published_idx', fields: ['published_on'] },
        ],
      }
    );
    return Book;
  }
}
