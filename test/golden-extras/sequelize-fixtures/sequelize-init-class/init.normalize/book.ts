import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Author } from './author.js';

export class Book extends Model<
  InferAttributes<Book>,
  InferCreationAttributes<Book>
> {
  declare id: CreationOptional<string>;
  declare title: string;
  declare isbn: CreationOptional<string | null>;
  declare pages: CreationOptional<number | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare authorId: string;

  declare author?: NonAttribute<Author>;

  static initModel(sequelize: Sequelize): typeof Book {
    Book.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        title: { type: DataTypes.STRING(255), allowNull: false },
        isbn: { type: DataTypes.STRING(13), unique: true },
        pages: { type: DataTypes.INTEGER, defaultValue: 0 },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        authorId: { type: DataTypes.UUID, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Book',
        tableName: 'book',
        timestamps: true,
        underscored: true,
        indexes: [
          { fields: ['title'] },
        ],
      }
    );
    return Book;
  }
}
