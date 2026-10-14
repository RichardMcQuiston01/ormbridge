import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Book } from './book.js';

export class Author extends Model<
  InferAttributes<Author>,
  InferCreationAttributes<Author>
> {
  declare id: CreationOptional<string>;
  declare handle: string;
  declare favouriteBookId: CreationOptional<number | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare latestBookId: CreationOptional<string | null>;

  declare latestBook?: NonAttribute<Book>;
  declare books?: NonAttribute<Book[]>;
  declare editedBooks?: NonAttribute<Book[]>;

  static initModel(sequelize: Sequelize): typeof Author {
    Author.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        handle: { type: DataTypes.STRING(30), allowNull: false, unique: true },
        favouriteBookId: DataTypes.INTEGER,
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        latestBookId: DataTypes.UUID,
      },
      {
        sequelize,
        modelName: 'Author',
        tableName: 'author',
        timestamps: true,
        underscored: true,
      }
    );
    return Author;
  }
}
