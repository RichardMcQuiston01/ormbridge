import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class Comment extends Model<
  InferAttributes<Comment>,
  InferCreationAttributes<Comment>
> {
  declare id: CreationOptional<string>;
  declare body: string;
  declare ownerId: string;
  declare ownerType: string;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): typeof Comment {
    Comment.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        body: { type: DataTypes.TEXT, allowNull: false },
        ownerId: { type: DataTypes.BIGINT, allowNull: false },
        ownerType: { type: DataTypes.STRING(30), allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Comment',
        tableName: 'comment',
        timestamps: true,
        underscored: true,
      }
    );
    return Comment;
  }
}
